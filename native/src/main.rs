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

/// microphone-button Name is the action verb: "Unmute mic" => muted, "Mute mic" => unmuted.
fn map_mute(name: &str) -> Option<bool> {
    if name.starts_with("Unmute") {
        Some(true)
    } else if name.starts_with("Mute") {
        Some(false)
    } else {
        None
    }
}

/// video-button Name: "Turn camera off" => camera on, "Turn camera on" => off.
fn map_camera(name: &str) -> Option<bool> {
    let n = name.to_lowercase();
    if n.contains("camera off") {
        Some(true)
    } else if n.contains("camera on") {
        Some(false)
    } else {
        None
    }
}

fn name_by_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> Option<String> {
    let cond = automation
        .create_property_condition(UIProperty::AutomationId, Variant::from(aid), None)
        .ok()?;
    let el = parent.find_first(TreeScope::Descendants, &cond).ok()?;
    el.get_name().ok()
}

fn has_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> bool {
    match automation.create_property_condition(UIProperty::AutomationId, Variant::from(aid), None) {
        Ok(cond) => parent.find_first(TreeScope::Descendants, &cond).is_ok(),
        Err(_) => false,
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
            if meeting.is_none()
                && has_id(automation, w, "microphone-button")
                && has_id(automation, w, "hangup-button")
            {
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
        if let Some(n) = name_by_id(automation, &m, "microphone-button") {
            snap.signals.mute = match map_mute(&n) {
                Some(v) => known(v, "uia-label"),
                None => Signal {
                    value: None,
                    available: false,
                    source: format!("uia-label?:{n}"),
                },
            };
        }
        if let Some(n) = name_by_id(automation, &m, "video-button") {
            snap.signals.camera = match map_camera(&n) {
                Some(v) => known(v, "uia-label"),
                None => Signal {
                    value: None,
                    available: false,
                    source: format!("uia-label?:{n}"),
                },
            };
        }
        // hand: under the React flyout — not passively readable (left flyout-only/unknown).
        snap.signals.sharing = known(sharing, "uia-window");
    }

    snap
}

/// Finds the active meeting window (TeamsWebView containing both microphone- and hangup-button).
fn find_meeting_window(automation: &UIAutomation) -> Option<UIElement> {
    let root = automation.get_root_element().ok()?;
    let true_cond = automation.create_true_condition().ok()?;
    let top = root.find_all(TreeScope::Children, &true_cond).ok()?;
    for w in &top {
        if w.get_classname().unwrap_or_default() == "TeamsWebView"
            && has_id(automation, w, "microphone-button")
            && has_id(automation, w, "hangup-button")
        {
            return Some(w.clone());
        }
    }
    None
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

    // Persistent service mode:  teamdeck-helper serve
    if args.get(1).map(|s| s.as_str()) == Some("serve") {
        serve(&automation);
        return;
    }

    // Control mode:  teamdeck-helper do <verb> [arg]
    if args.get(1).map(|s| s.as_str()) == Some("do") {
        let verb = args.get(2).map(|s| s.as_str()).unwrap_or("");
        let arg = args.get(3).map(|s| s.as_str());
        let ok = do_command(&automation, verb, arg);
        println!(
            "{}",
            serde_json::json!({ "cmd": verb, "arg": arg, "ok": ok })
        );
        std::process::exit(if ok { 0 } else { 1 });
    }

    // Read mode: emit one snapshot, or stream with --loop.
    let loop_mode = args.iter().any(|a| a == "--loop");
    loop {
        let snap = build_snapshot(&automation);
        println!("{}", serde_json::to_string(&snap).unwrap());
        if !loop_mode {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}
