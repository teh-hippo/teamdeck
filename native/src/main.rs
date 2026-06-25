//! TeamDeck native helper.
//!
//! Reads Microsoft Teams meeting state via Windows UI Automation and actuates the meeting controls.
//! Emits the snapshot contract as one JSON object per line on stdout.

use serde::Serialize;
use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::time::{SystemTime, UNIX_EPOCH};

use uiautomation::patterns::{UIExpandCollapsePattern, UIInvokePattern};
use uiautomation::types::{TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
};

#[derive(Serialize)]
struct Signal {
    value: Option<bool>,
    available: bool,
    source: String,
}

impl Signal {
    fn unknown() -> Self {
        Signal {
            value: None,
            available: false,
            source: "none".into(),
        }
    }
}

#[derive(Serialize)]
struct Signals {
    mute: Signal,
    camera: Signal,
    hand: Signal,
    sharing: Signal,
}

#[derive(Serialize)]
struct WindowInfo {
    pid: u32,
    name: String,
}

/// The snapshot contract emitted as one JSON line per tick. `teamsRunning`, `inMeeting` and
/// `signals` drive the plugin; `schema`, `ts`, `window` and each signal's `source` are diagnostic
/// fields for a human inspecting the helper, not consumed by the plugin's mapper.
#[derive(Serialize)]
struct Snapshot {
    schema: u32,
    ts: u128,
    #[serde(rename = "teamsRunning")]
    teams_running: bool,
    #[serde(rename = "inMeeting")]
    in_meeting: bool,
    window: Option<WindowInfo>,
    signals: Signals,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn known(value: bool, source: &str) -> Signal {
    Signal {
        value: Some(value),
        available: true,
        source: source.into(),
    }
}

/// Localisation seam: UI label fragments that reveal mic/camera state from a control's UIA Name
/// (the action verb). Teams exposes mic/camera on-off state only as localised text, so supporting
/// another display language means adding its verbs here -- the only change a new locale needs.
/// Order matters: list more specific needles first (e.g. "unmute" before "mute", which it contains).
struct StateLabel {
    /// Lower-case substring to look for in the control's Name.
    needle: &'static str,
    /// The boolean state that substring implies.
    value: bool,
}

/// Mic button Name is the action verb: an "unmute" verb means you are muted; "mute" means live.
const MUTE_LABELS: &[StateLabel] = &[
    StateLabel {
        needle: "unmute",
        value: true,
    },
    StateLabel {
        needle: "mute",
        value: false,
    },
];

/// Video button Name: a "camera off" verb means the camera is on, and vice versa.
const CAMERA_LABELS: &[StateLabel] = &[
    StateLabel {
        needle: "camera off",
        value: true,
    },
    StateLabel {
        needle: "camera on",
        value: false,
    },
];

/// Resolves a control's boolean state from its (localised) Name via the first matching label,
/// matched case-insensitively. Returns None when no known label matches, so the caller marks the
/// control unknown rather than guessing.
fn match_label(name: &str, labels: &[StateLabel]) -> Option<bool> {
    let n = name.to_lowercase();
    labels
        .iter()
        .find(|l| n.contains(l.needle))
        .map(|l| l.value)
}

/// microphone-button Name is the action verb: "Unmute mic" => muted, "Mute mic" => unmuted.
fn map_mute(name: &str) -> Option<bool> {
    match_label(name, MUTE_LABELS)
}

/// video-button Name: "Turn camera off" => camera on, "Turn camera on" => off.
fn map_camera(name: &str) -> Option<bool> {
    match_label(name, CAMERA_LABELS)
}

fn name_by_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> Option<String> {
    find_first_id(automation, parent, aid)?.get_name().ok()
}

fn has_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> bool {
    find_first_id(automation, parent, aid).is_some()
}

/// Reads a labelled control's value from its UIA Name via a label->bool mapper, returning an
/// "unknown" signal when the control is absent or its label is unrecognised.
fn read_signal(
    automation: &UIAutomation,
    meeting: &UIElement,
    aid: &str,
    map: fn(&str) -> Option<bool>,
) -> Signal {
    let Some(n) = name_by_id(automation, meeting, aid) else {
        return Signal::unknown();
    };
    match map(&n) {
        Some(v) => known(v, "uia-label"),
        None => Signal {
            value: None,
            available: false,
            source: format!("uia-label?:{n}"),
        },
    }
}

fn build_snapshot(automation: &UIAutomation) -> Snapshot {
    let mut snap = Snapshot {
        schema: 1,
        ts: now_ms(),
        teams_running: false,
        in_meeting: false,
        window: None,
        signals: Signals {
            mute: Signal::unknown(),
            camera: Signal::unknown(),
            hand: Signal {
                value: None,
                available: false,
                source: "flyout-only".into(),
            },
            sharing: Signal::unknown(),
        },
    };

    let root = match automation.get_root_element() {
        Ok(r) => r,
        Err(_) => return snap,
    };
    let true_cond = match automation.create_true_condition() {
        Ok(c) => c,
        Err(_) => return snap,
    };
    let top = match root.find_all(TreeScope::Children, &true_cond) {
        Ok(t) => t,
        Err(_) => return snap,
    };

    let mut meeting: Option<UIElement> = None;
    let mut sharing = false;
    for w in &top {
        if w.get_classname().unwrap_or_default() == "TeamsWebView" {
            snap.teams_running = true;
            if meeting.is_none() && is_meeting_window(automation, w) {
                meeting = Some(w.clone());
            }
        }
        if w.get_name()
            .unwrap_or_default()
            .starts_with("Sharing control bar")
        {
            sharing = true;
        }
    }

    if let Some(m) = meeting {
        // Selection required microphone-button AND hangup-button, so this is an active meeting.
        snap.in_meeting = true;
        snap.window = Some(WindowInfo {
            pid: m.get_process_id().unwrap_or(0),
            name: m.get_name().unwrap_or_default(),
        });
        snap.signals.mute = read_signal(automation, &m, "microphone-button", map_mute);
        snap.signals.camera = read_signal(automation, &m, "video-button", map_camera);
        // hand: under the React flyout — not passively readable (left flyout-only/unknown).
        snap.signals.sharing = known(sharing, "uia-window");
    }

    snap
}

/// Whether a top-level window is an active Teams meeting: a TeamsWebView that contains both the
/// microphone and hangup buttons.
fn is_meeting_window(automation: &UIAutomation, w: &UIElement) -> bool {
    w.get_classname().unwrap_or_default() == "TeamsWebView"
        && has_id(automation, w, "microphone-button")
        && has_id(automation, w, "hangup-button")
}

/// Finds the active meeting window (TeamsWebView containing both microphone- and hangup-button).
fn find_meeting_window(automation: &UIAutomation) -> Option<UIElement> {
    let root = automation.get_root_element().ok()?;
    let true_cond = automation.create_true_condition().ok()?;
    let top = root.find_all(TreeScope::Children, &true_cond).ok()?;
    top.into_iter().find(|w| is_meeting_window(automation, w))
}

fn find_first_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> Option<UIElement> {
    let cond = automation
        .create_property_condition(UIProperty::AutomationId, Variant::from(aid), None)
        .ok()?;
    parent.find_first(TreeScope::Descendants, &cond).ok()
}

fn invoke_element(el: &UIElement) -> bool {
    matches!(el.get_pattern::<UIInvokePattern>(), Ok(p) if p.invoke().is_ok())
}

fn invoke_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> bool {
    find_first_id(automation, parent, aid)
        .map(|el| invoke_element(&el))
        .unwrap_or(false)
}

/// Opens the React flyout, triggers an item (raise-hand or a reaction), then collapses it.
fn invoke_in_flyout(automation: &UIAutomation, meeting: &UIElement, aid: &str) -> bool {
    let react = match find_first_id(automation, meeting, "reaction-menu-button") {
        Some(e) => e,
        None => return false,
    };
    let ec = react.get_pattern::<UIExpandCollapsePattern>().ok();
    if let Some(p) = &ec {
        let _ = p.expand();
    }
    // The flyout DOM builds lazily; poll for the item (up to ~750ms) instead of a fixed sleep.
    let mut ok = false;
    for _ in 0..15 {
        std::thread::sleep(std::time::Duration::from_millis(50));
        if let Some(el) = find_first_id(automation, meeting, aid) {
            ok = invoke_element(&el);
            break;
        }
    }
    if let Some(p) = &ec {
        let _ = p.collapse();
    }
    ok
}

/// Restores `prev` as the foreground window (UIA Invoke briefly activates Teams).
fn restore_foreground(prev: HWND) {
    unsafe {
        let fg = GetForegroundWindow();
        let mut pid = 0u32;
        let fg_thread = GetWindowThreadProcessId(fg, Some(&mut pid));
        let cur = GetCurrentThreadId();
        let _ = AttachThreadInput(cur, fg_thread, true);
        let _ = SetForegroundWindow(prev);
        let _ = AttachThreadInput(cur, fg_thread, false);
    }
}

fn react_id(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "like" => "like-button",
        "love" => "heart-button",
        "laugh" => "laugh-button",
        "surprised" => "surprised-button",
        "applause" => "applause-button",
        _ => return None,
    })
}

/// Executes a control verb via UIA, restoring the user's foreground window afterwards.
fn do_command(automation: &UIAutomation, verb: &str, arg: Option<&str>) -> bool {
    let meeting = match find_meeting_window(automation) {
        Some(m) => m,
        None => return false,
    };
    let prev = unsafe { GetForegroundWindow() };
    let ok = match verb {
        "toggle-mute" => invoke_id(automation, &meeting, "microphone-button"),
        "toggle-camera" => invoke_id(automation, &meeting, "video-button"),
        "leave" => invoke_id(automation, &meeting, "hangup-button"),
        "raise-hand" => invoke_in_flyout(automation, &meeting, "raisehands-button"),
        "react" => match arg.and_then(react_id) {
            Some(id) => invoke_in_flyout(automation, &meeting, id),
            None => false,
        },
        _ => false,
    };
    restore_foreground(prev);
    ok
}

fn emit_line(s: &str) -> bool {
    let out = std::io::stdout();
    let mut h = out.lock();
    writeln!(h, "{s}").and_then(|_| h.flush()).is_ok()
}

/// Persistent service: read newline-delimited command JSON on stdin, stream snapshot JSON on
/// stdout (`{"type":"snapshot",...}`) plus command results (`{"type":"result",...}`). Exits when
/// the parent closes stdin (channel disconnects) or the stdout pipe breaks, so it never outlives
/// the plugin that spawned it.
fn serve(automation: &UIAutomation) {
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) => {
                    if tx.send(l).is_err() {
                        break;
                    }
                }
                // A line read error (e.g. invalid UTF-8) skips just that line; genuine EOF ends the
                // loop by yielding None, which drops `tx` and disconnects the channel checked below.
                Err(_) => continue,
            }
        }
        // EOF on stdin (parent exited): dropping `tx` disconnects the channel checked below.
    });
    loop {
        // Drain pending commands; exit if the parent has closed stdin.
        loop {
            match rx.try_recv() {
                Ok(line) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(cmd) = serde_json::from_str::<serde_json::Value>(line) {
                        let verb = cmd.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                        let arg = cmd.get("arg").and_then(|v| v.as_str());
                        let ok = do_command(automation, verb, arg);
                        if !emit_line(
                            &serde_json::json!({ "type": "result", "cmd": verb, "arg": arg, "ok": ok })
                                .to_string(),
                        ) {
                            return;
                        }
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return, // parent closed stdin
            }
        }
        let snap = build_snapshot(automation);
        if let Ok(mut v) = serde_json::to_value(&snap) {
            v["type"] = serde_json::json!("snapshot");
            if !emit_line(&v.to_string()) {
                return; // stdout pipe broken: the parent is gone.
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let automation = match UIAutomation::new() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("failed to init UIAutomation: {e}");
            std::process::exit(1);
        }
    };

    // Persistent service mode (used by the plugin):  teamdeck-helper serve
    if args.get(1).map(|s| s.as_str()) == Some("serve") {
        serve(&automation);
        return;
    }

    // Read mode (used by the CI and release smoke tests): emit one snapshot and exit.
    let snap = build_snapshot(&automation);
    println!("{}", serde_json::to_string(&snap).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_mute_reads_the_action_verb() {
        assert_eq!(map_mute("Unmute mic"), Some(true), "Unmute => muted");
        assert_eq!(map_mute("Mute mic"), Some(false), "Mute => unmuted");
        assert_eq!(map_mute("Microphone"), None);
    }

    #[test]
    fn label_matching_is_case_insensitive_and_order_aware() {
        // The seam matches case-insensitively, so a localised label in any casing still resolves.
        assert_eq!(map_mute("UNMUTE MIC"), Some(true));
        assert_eq!(map_mute("unmute mic"), Some(true));
        // "unmute" contains "mute": the more specific needle must win, never collapse to unmuted.
        assert_eq!(
            map_mute("Unmute"),
            Some(true),
            "must not match the 'mute' needle first"
        );
        assert_eq!(map_camera("turn camera on"), Some(false));
    }

    #[test]
    fn map_camera_is_case_insensitive() {
        assert_eq!(
            map_camera("Turn camera off"),
            Some(true),
            "off label => camera on"
        );
        assert_eq!(map_camera("TURN CAMERA OFF"), Some(true));
        assert_eq!(
            map_camera("Turn camera on"),
            Some(false),
            "on label => camera off"
        );
        assert_eq!(map_camera("No control here"), None);
    }

    #[test]
    fn react_id_maps_every_reaction() {
        assert_eq!(react_id("like"), Some("like-button"));
        assert_eq!(react_id("love"), Some("heart-button"));
        assert_eq!(react_id("laugh"), Some("laugh-button"));
        assert_eq!(react_id("surprised"), Some("surprised-button"));
        assert_eq!(react_id("applause"), Some("applause-button"));
        assert_eq!(react_id("nope"), None);
    }

    #[test]
    fn snapshot_serialises_the_wire_contract() {
        let snap = Snapshot {
            schema: 1,
            ts: 0,
            teams_running: true,
            in_meeting: true,
            window: None,
            signals: Signals {
                mute: known(false, "uia-label"),
                camera: Signal::unknown(),
                hand: Signal::unknown(),
                sharing: known(true, "uia-window"),
            },
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&snap).unwrap()).unwrap();
        assert_eq!(
            v["teamsRunning"],
            serde_json::json!(true),
            "uses the renamed key"
        );
        assert_eq!(v["inMeeting"], serde_json::json!(true));
        assert!(
            v.get("teams_running").is_none(),
            "must not emit the snake_case field name"
        );
        assert_eq!(v["signals"]["mute"]["value"], serde_json::json!(false));
        assert_eq!(v["signals"]["mute"]["available"], serde_json::json!(true));
    }
}
