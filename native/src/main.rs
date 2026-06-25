//! TeamDeck native helper.
//!
//! Reads Microsoft Teams meeting state via Windows UI Automation and actuates the meeting controls.
//! Emits the snapshot contract as one JSON object per line on stdout.

use serde::Serialize;
use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use uiautomation::patterns::{
    UIExpandCollapsePattern, UIInvokePattern, UILegacyIAccessiblePattern,
};
use uiautomation::types::{Handle, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};

use windows::core::w;
use windows::Win32::Foundation::{ERROR_SUCCESS, HWND};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_QWORD};
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

/// Camera-on state read from the OS, independent of Teams' display language: the per-app webcam
/// privacy record. `LastUsedTimeStop == 0` means Microsoft Teams is currently capturing video
/// (camera on); a non-zero FILETIME means capture stopped (camera off). Returns `None` when the
/// record is missing or unreadable, so the caller falls back to the localised button label.
/// `MSTeams_8wekyb3d8bbwe` is new Teams' fixed Microsoft Store identity.
fn teams_webcam_in_use() -> Option<bool> {
    let mut value: u64 = 0;
    let mut size = std::mem::size_of::<u64>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!(
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam\MSTeams_8wekyb3d8bbwe"
            ),
            w!("LastUsedTimeStop"),
            RRF_RT_REG_QWORD,
            None,
            Some((&mut value as *mut u64).cast::<core::ffi::c_void>()),
            Some(&mut size),
        )
    };
    (status == ERROR_SUCCESS).then_some(value == 0)
}

fn name_by_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> Option<String> {
    find_first_id(automation, parent, aid)?.get_name().ok()
}

fn has_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> bool {
    find_first_id(automation, parent, aid).is_some()
}

/// Maps a control's (localised) UIA Name to a Signal: a recognised label gives a known value, an
/// unrecognised one is tagged `uia-label?:<name>` so the plugin can surface it as a diagnostic.
fn label_signal(name: &str, map: fn(&str) -> Option<bool>) -> Signal {
    match map(name) {
        Some(v) => known(v, "uia-label"),
        None => Signal {
            value: None,
            available: false,
            source: format!("uia-label?:{name}"),
        },
    }
}

/// Reads a labelled control's value from its UIA Name via a label->bool mapper, returning an
/// "unknown" signal when the control is absent or its label is unrecognised.
fn read_signal(
    automation: &UIAutomation,
    meeting: &UIElement,
    aid: &str,
    map: fn(&str) -> Option<bool>,
) -> Signal {
    match name_by_id(automation, meeting, aid) {
        Some(n) => label_signal(&n, map),
        None => Signal::unknown(),
    }
}

/// A cache request that fetches each element's ClassName and Name in the same cross-process call as
/// the enumeration, so the per-window reads in the top-level walk are local (no UIA round-trip each).
fn top_cache_request(
    automation: &UIAutomation,
) -> uiautomation::Result<uiautomation::core::UICacheRequest> {
    let req = automation.create_cache_request()?;
    req.add_property(UIProperty::ClassName)?;
    req.add_property(UIProperty::Name)?;
    Ok(req)
}

fn build_snapshot(automation: &UIAutomation, cache: &mut Option<isize>) -> Snapshot {
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

    // Top-level pass for Teams-running (any TeamsWebView) and screen-sharing (a sibling "Sharing
    // control bar" window). Both need this enumeration, so a cache request fetches ClassName + Name
    // in one round-trip and the reads below are local. On a warm cache `locate_meeting` reuses the
    // cached HWND and skips re-finding; only a cold tick pays a second top-level walk (inside
    // `find_meeting_window`), which is rare (startup / post-invalidation).
    let mut sharing = false;
    if let (Ok(root), Ok(true_cond), Ok(req)) = (
        automation.get_root_element(),
        automation.create_true_condition(),
        top_cache_request(automation),
    ) {
        if let Ok(top) = root.find_all_build_cache(TreeScope::Children, &true_cond, &req) {
            for w in &top {
                if w.get_cached_classname().unwrap_or_default() == "TeamsWebView" {
                    snap.teams_running = true;
                }
                if w.get_cached_name()
                    .unwrap_or_default()
                    .starts_with("Sharing control bar")
                {
                    sharing = true;
                }
            }
        }
    }

    if let Some(m) = locate_meeting(automation, cache) {
        // Liveness is confirmed by the mic read itself -- a live meeting always exposes
        // microphone-button -- so there is no separate validation probe. If the cached window no
        // longer has it (meeting ended / window reused), drop the cache and report not-in-meeting.
        match name_by_id(automation, &m, "microphone-button") {
            Some(mic) => {
                // A live meeting always exposes microphone-button; on the warm path this mic read
                // is the only liveness gate (vs the cold path's strict mic+hangup match) -- a small,
                // intentional relaxation for speed. Being in a meeting implies Teams is running, so
                // assert that invariant here regardless of whether the top-level walk above
                // succeeded (it can transiently fail while the cached HWND still resolves).
                snap.in_meeting = true;
                snap.teams_running = true;
                snap.window = Some(WindowInfo {
                    pid: m.get_process_id().unwrap_or(0),
                    name: m.get_name().unwrap_or_default(),
                });
                snap.signals.mute = label_signal(&mic, map_mute);
                // Prefer the OS webcam privacy signal (language-independent); fall back to the
                // localised video-button label only when the per-app record is unavailable.
                snap.signals.camera = match teams_webcam_in_use() {
                    Some(on) => known(on, "os-webcam"),
                    None => read_signal(automation, &m, "video-button", map_camera),
                };
                // hand: under the React flyout -- not passively readable (left flyout-only/unknown).
                snap.signals.sharing = known(sharing, "uia-window");
            }
            None => *cache = None,
        }
    }

    snap
}

/// Resolves the active meeting window, preferring the cached HWND (one `ElementFromHandle` plus a
/// cheap classname check, ~sub-ms vs the full enumeration) and otherwise re-finding it from scratch
/// (the strict microphone+hangup match). Callers confirm it is still a live meeting via their own
/// control reads (the snapshot's mic read, a command's button lookup), so no separate probe is run
/// here. Updates `cache`, clearing it when the cached window is gone or no longer a TeamsWebView.
///
/// The cache is only ever seeded by `find_meeting_window`, so it can bind to the wrong window only if
/// the OS recycles the meeting's HWND onto another *live* TeamsWebView meeting -- which needs HWND
/// reuse plus concurrent meetings, out of scope under the single-meeting assumption. The common
/// recycle (onto the main Teams window, which has no microphone-button) self-heals: the caller's mic
/// read fails and clears the cache.
fn locate_meeting(automation: &UIAutomation, cache: &mut Option<isize>) -> Option<UIElement> {
    if let Some(h) = *cache {
        if let Ok(el) = automation.element_from_handle(Handle::from(h)) {
            if el
                .get_classname()
                .map(|c| c == "TeamsWebView")
                .unwrap_or(false)
            {
                return Some(el);
            }
        }
        *cache = None;
    }
    let m = find_meeting_window(automation)?;
    *cache = m.get_native_window_handle().ok().map(|h| h.into());
    Some(m)
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

/// Actuates a control with the fast, focus-free MSAA default action (`accDoDefaultAction`, ~0.3ms
/// and provider-level). Falls back to `UIInvokePattern::invoke` (which blocks ~2s on Teams' Chromium
/// control) only when the Legacy pattern is unavailable. The foreground is captured before and
/// restored only if the actuation actually moved it -- so the common DoDefaultAction path pays no
/// focus dance, while the Invoke fallback (which briefly foregrounds Teams) is still corrected, and
/// the behaviour is invariant of which path runs.
fn actuate(el: &UIElement) -> bool {
    let prev = unsafe { GetForegroundWindow() };
    let ok = if let Ok(p) = el.get_pattern::<UILegacyIAccessiblePattern>() {
        p.do_default_action().is_ok() || invoke_element(el)
    } else {
        invoke_element(el)
    };
    if unsafe { GetForegroundWindow() } != prev {
        restore_foreground(prev);
    }
    ok
}

/// Actuates a control found by AutomationId. Returns `None` when the control is absent -- the caller
/// treats that as a possibly-stale meeting window and re-finds -- or `Some(success)` once it acted.
fn act_id(automation: &UIAutomation, parent: &UIElement, aid: &str) -> Option<bool> {
    find_first_id(automation, parent, aid).map(|el| actuate(&el))
}

/// Opens the React flyout, triggers an item (raise-hand or a reaction), then collapses it. Returns
/// `None` when the React button is absent (stale window), else `Some(success)`. Expand/collapse and
/// the item Invoke briefly foreground Teams, so the foreground is saved and restored here.
fn invoke_in_flyout(automation: &UIAutomation, meeting: &UIElement, aid: &str) -> Option<bool> {
    let react = find_first_id(automation, meeting, "reaction-menu-button")?;
    let prev = unsafe { GetForegroundWindow() };
    let ec = react.get_pattern::<UIExpandCollapsePattern>().ok();
    if let Some(p) = &ec {
        let _ = p.expand();
    }
    // The flyout DOM builds lazily; poll for the item (up to ~750ms) instead of a fixed sleep.
    let mut ok = false;
    for _ in 0..15 {
        std::thread::sleep(Duration::from_millis(50));
        if let Some(el) = find_first_id(automation, meeting, aid) {
            ok = invoke_element(&el);
            break;
        }
    }
    if let Some(p) = &ec {
        let _ = p.collapse();
    }
    restore_foreground(prev);
    Some(ok)
}

/// Restores `prev` as the foreground window (the Invoke fallback briefly activates Teams).
fn restore_foreground(prev: HWND) {
    unsafe {
        let fg = GetForegroundWindow();
        let mut pid = 0u32;
        let fg_thread = GetWindowThreadProcessId(fg, Some(&mut pid));
        let cur = GetCurrentThreadId();
        // AttachThreadInput(cur, cur, ...) is invalid, so skip the attach when the helper itself is
        // the foreground thread (only possible on a manual run, never for the plugin's spawned child).
        let attach = fg_thread != cur;
        if attach {
            let _ = AttachThreadInput(cur, fg_thread, true);
        }
        let _ = SetForegroundWindow(prev);
        if attach {
            let _ = AttachThreadInput(cur, fg_thread, false);
        }
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

/// What a command verb maps to, decided WITHOUT touching UIA so it is unit-testable. The
/// no-double-actuate guarantee rests on this: `Noop` never actuates and never triggers a stale-cache
/// retry, while `Toggle`/`Flyout` carry the exact AutomationId to act on.
#[derive(Debug, PartialEq, Eq)]
enum Action {
    /// Actuate a single control by AutomationId (mute / camera / leave).
    Toggle(&'static str),
    /// Open the React flyout and actuate an item by AutomationId (raise-hand / reactions).
    Flyout(&'static str),
    /// Unknown verb or unrecognised reaction: do nothing, report ok:false, no retry.
    Noop,
}

/// Maps a wire verb (and optional arg) to its control action, purely (no UIA). See `Action`.
fn route(verb: &str, arg: Option<&str>) -> Action {
    match verb {
        "toggle-mute" => Action::Toggle("microphone-button"),
        "toggle-camera" => Action::Toggle("video-button"),
        "leave" => Action::Toggle("hangup-button"),
        "raise-hand" => Action::Flyout("raisehands-button"),
        "react" => match arg.and_then(react_id) {
            Some(id) => Action::Flyout(id),
            None => Action::Noop,
        },
        _ => Action::Noop,
    }
}

/// Executes a routed verb against an already-resolved meeting window. Returns `None` only when the
/// target control is absent (so the caller can re-find a possibly-stale meeting window), or
/// `Some(success)` once a control acted (or the verb/arg was a no-op -- no retry, never double-acts).
fn dispatch(
    automation: &UIAutomation,
    meeting: &UIElement,
    verb: &str,
    arg: Option<&str>,
) -> Option<bool> {
    match route(verb, arg) {
        Action::Toggle(aid) => act_id(automation, meeting, aid),
        Action::Flyout(aid) => invoke_in_flyout(automation, meeting, aid),
        Action::Noop => Some(false),
    }
}

/// Executes a control verb against the cached meeting window. If the target control is missing --
/// the cached window was rebuilt (rejoin) or the meeting ended -- it clears the cache, re-finds the
/// meeting once, and retries, so a key press is never silently dropped on a stale cache.
fn do_command(
    automation: &UIAutomation,
    cache: &mut Option<isize>,
    verb: &str,
    arg: Option<&str>,
) -> bool {
    if let Some(m) = locate_meeting(automation, cache) {
        if let Some(ok) = dispatch(automation, &m, verb, arg) {
            return ok;
        }
    }
    *cache = None;
    match locate_meeting(automation, cache) {
        Some(m) => dispatch(automation, &m, verb, arg).unwrap_or(false),
        None => false,
    }
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
    // HWND of the active meeting window, cached across ticks and commands so the hot path skips the
    // ~170-300ms top-level enumeration + per-candidate descendant probes (see `locate_meeting`).
    let mut cache: Option<isize> = None;
    loop {
        // Emit a snapshot: this is both the idle tick and the immediate post-command refresh (the
        // loop returns straight here after handling commands, so new state shows without waiting).
        let snap = build_snapshot(automation, &mut cache);
        if let Ok(mut v) = serde_json::to_value(&snap) {
            v["type"] = serde_json::json!("snapshot");
            if !emit_line(&v.to_string()) {
                return; // stdout pipe broken: the parent is gone.
            }
        }
        // Wait up to 300ms for a command. Unlike a fixed sleep, a command wakes the loop at once;
        // a burst is then drained and run before the next snapshot, coalescing it to one emission.
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(first) => {
                if !handle_command(automation, &mut cache, &first) {
                    return;
                }
                while let Ok(next) = rx.try_recv() {
                    if !handle_command(automation, &mut cache, &next) {
                        return;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {} // idle: loop re-snapshots
            Err(mpsc::RecvTimeoutError::Disconnected) => return, // parent closed stdin
        }
    }
}

/// Parses and runs one command line, emitting its `{"type":"result",...}`. Returns false only when
/// the stdout pipe breaks (the parent is gone), so the caller exits.
fn handle_command(automation: &UIAutomation, cache: &mut Option<isize>, line: &str) -> bool {
    let line = line.trim();
    if line.is_empty() {
        return true;
    }
    let Ok(cmd) = serde_json::from_str::<serde_json::Value>(line) else {
        return true;
    };
    let verb = cmd.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
    let arg = cmd.get("arg").and_then(|v| v.as_str());
    let ok = do_command(automation, cache, verb, arg);
    emit_line(
        &serde_json::json!({ "type": "result", "cmd": verb, "arg": arg, "ok": ok }).to_string(),
    )
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
    let snap = build_snapshot(&automation, &mut None);
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
    fn route_maps_verbs_and_treats_unknowns_as_noop() {
        assert_eq!(
            route("toggle-mute", None),
            Action::Toggle("microphone-button")
        );
        assert_eq!(route("toggle-camera", None), Action::Toggle("video-button"));
        assert_eq!(route("leave", None), Action::Toggle("hangup-button"));
        assert_eq!(
            route("raise-hand", None),
            Action::Flyout("raisehands-button")
        );
        assert_eq!(route("react", Some("like")), Action::Flyout("like-button"));
        assert_eq!(
            route("react", Some("surprised")),
            Action::Flyout("surprised-button")
        );
        // Unknown verb and unrecognised reaction collapse to Noop: ok:false, and crucially no
        // stale-cache retry (so a bad command can never be mistaken for a stale window or double-act).
        assert_eq!(route("react", Some("nope")), Action::Noop);
        assert_eq!(route("react", None), Action::Noop);
        assert_eq!(route("bogus", None), Action::Noop);
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
