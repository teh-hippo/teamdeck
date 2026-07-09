use crate::command::{handle_command, parse_log_reading_cmd, Handled};
use crate::handlers::{reconcile_name_handler, register_window_handlers, NameReg};
use crate::labels::{label_signal, teams_webcam_in_use, CAMERA_LABELS, HAND_LABELS, MUTE_LABELS};
use crate::meeting::{cached_name, locate_meeting, top_cache_request, MeetingCache};
use crate::presence::presence_reader_loop;
use crate::snapshot::{
    known, now_ms, Presence, PresenceState, Signal, Signals, Snapshot, WindowInfo,
};
use std::io::{BufRead, ErrorKind, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};
use uiautomation::types::TreeScope;
use uiautomation::{UIAutomation, UIElement};

pub(crate) fn build_snapshot(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    presence: &PresenceState,
) -> Snapshot {
    let mut snap = Snapshot {
        schema: 1,
        ts: now_ms(),
        teams_running: false,
        in_meeting: false,
        window: None,
        signals: Signals {
            mute: Signal::unknown(),
            camera: Signal::unknown(),
            hand: Signal::unknown(),
            sharing: Signal::unknown(),
        },
        presence: presence.clone(),
    };

    // One cached top-level pass: Teams-running (any TeamsWebView), screen-sharing (sibling "Sharing control bar" window), and the TeamsWebView meeting candidates.
    let mut sharing = false;
    let mut candidates: Vec<UIElement> = Vec::new();
    if let (Ok(root), Ok(true_cond), Ok(req)) = (
        automation.get_root_element(),
        automation.create_true_condition(),
        top_cache_request(automation),
    ) {
        if let Ok(top) = root.find_all_build_cache(TreeScope::Children, &true_cond, &req) {
            for w in &top {
                if w.get_cached_classname().unwrap_or_default() == "TeamsWebView" {
                    snap.teams_running = true;
                    candidates.push(w.clone());
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

    if let Some(m) = locate_meeting(automation, cache, &candidates) {
        // The mic read is the liveness gate: present => in a meeting (else drop the cache and bail).
        match cached_name(automation, cache, &m, "microphone-button") {
            Some(mic) => {
                snap.in_meeting = true;
                // In a meeting implies Teams running, even if the top-level walk transiently missed it.
                snap.teams_running = true;
                snap.window = Some(WindowInfo {
                    pid: m.get_process_id().unwrap_or(0),
                    name: m.get_name().unwrap_or_default(),
                });
                snap.signals.mute = label_signal(&mic, MUTE_LABELS);
                // Prefer the OS webcam signal; fall back to the localised video-button label.
                snap.signals.camera = match teams_webcam_in_use() {
                    Some(on) => known(on, "os-webcam"),
                    None => match cached_name(automation, cache, &m, "video-button") {
                        Some(n) => label_signal(&n, CAMERA_LABELS),
                        None => Signal::unknown(),
                    },
                };
                // Hand state from the toolbar raise-hand button's localised Name (the action verb), like mute/camera; absent in some channel-meeting / live-event / 1:1 variants, where it renders unknown.
                snap.signals.hand = match cached_name(automation, cache, &m, "raisehands-button") {
                    Some(n) => label_signal(&n, HAND_LABELS),
                    None => Signal::unknown(),
                };
                snap.signals.sharing = known(sharing, "uia-window");
            }
            None => cache.rebind(None),
        }
    }

    // Teams gone: downgrade a stale last-known presence to Unknown but keep `source`, so the plugin can still tell opt-in-off (`disabled`) from a running read (`teams-log`).
    if !snap.teams_running && snap.presence.value != Presence::Unknown {
        snap.presence.value = Presence::Unknown;
        snap.presence.known = false;
    }

    snap
}

/// Messages the serve loop multiplexes: a stdin command, a state-changed ping from a UIA handler, and a worker's result line.
pub(crate) enum Msg {
    Cmd(String),
    Ping,
    Result(String),
    /// A presence change read from the Teams log by the background presence reader.
    Presence(Presence),
    /// stdin EOF (parent gone): exit. Needed because UIA handlers hold their own `Sender` clones, so dropping the reader's tx no longer disconnects the channel.
    Eof,
}

// Compile-time assert that the handler-captured `Sender<Msg>` is Send+Sync (the crate stores handlers with no such bound).
const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Sender<Msg>>();
};

pub(crate) fn emit_line(s: &str) -> bool {
    let out = std::io::stdout();
    let mut h = out.lock();
    writeln!(h, "{s}").and_then(|_| h.flush()).is_ok()
}

/// Builds the `{"type":"result",...}` line; single source of truth for the wire result contract.
pub(crate) fn result_line(verb: &str, arg: Option<&str>, ok: bool) -> String {
    serde_json::json!({ "type": "result", "cmd": verb, "arg": arg, "ok": ok }).to_string()
}

/// Emits one snapshot line and reconciles the Name handler. Returns `Some(in_meeting)` on success;
/// `None` only when the stdout pipe is broken (parent gone).
fn emit_snapshot(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    name_reg: &mut Option<NameReg>,
    tx: &Sender<Msg>,
    presence: &PresenceState,
) -> Option<bool> {
    let snap = build_snapshot(automation, cache, presence);
    let in_meeting = snap.in_meeting;
    reconcile_name_handler(automation, name_reg, cache.hwnd, in_meeting, tx);
    let ok = match serde_json::to_value(&snap) {
        Ok(mut v) => {
            v["type"] = serde_json::json!("snapshot");
            emit_line(&v.to_string())
        }
        Err(_) => true,
    };
    ok.then_some(in_meeting)
}

/// Whether the loop should emit now: a snapshot is pending (`dirty`) and the debounce has elapsed.
fn should_emit(dirty: bool, since_emit: Duration, debounce: Duration) -> bool {
    dirty && since_emit >= debounce
}

/// How long to wait for the next message: remaining debounce while a snapshot is pending, else the full idle tick.
fn loop_wait(dirty: bool, since_emit: Duration, debounce: Duration, tick: Duration) -> Duration {
    if dirty {
        debounce.saturating_sub(since_emit)
    } else {
        tick
    }
}

/// The backstop resnapshot interval, chosen by meeting state. Event handlers drive real changes, so this only reconciles a *missed* event: short in a meeting (bounds a missed mute/leave), long otherwise (a window-open event catches a meeting starting).
fn effective_tick(in_meeting: bool, meeting_tick: Duration, idle_tick: Duration) -> Duration {
    if in_meeting {
        meeting_tick
    } else {
        idle_tick
    }
}

/// Persistent service: streams snapshot + result JSON on stdout, reads command JSON on stdin. Event-driven (Name + window handlers) over an adaptive backstop tick (see `effective_tick`), snapshots debounced to ~150ms. Exits when stdin or stdout closes.
pub(crate) fn serve(automation: &UIAutomation) {
    let (tx, rx) = mpsc::channel::<Msg>();
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                match line {
                    Ok(l) => {
                        if tx.send(Msg::Cmd(l)).is_err() {
                            break;
                        }
                    }
                    // A broken Windows pipe yields a repeating read error, not clean EOF: stop on it; skip only non-UTF-8 lines.
                    Err(e) if e.kind() == ErrorKind::InvalidData => continue,
                    Err(_) => break,
                }
            }
            // stdin EOF (parent gone): tell the loop to exit (handlers hold their own tx clones).
            let _ = tx.send(Msg::Eof);
        });
    }

    // Opt-in gate for reading log presence (default OFF); the reader thread tails only while it is set, and `presence_reseed` forces a fresh seed on every "on" so a rapid off/on re-toggle can't leave the tile stuck.
    let presence_enabled = Arc::new(AtomicBool::new(false));
    let presence_reseed = Arc::new(AtomicBool::new(false));
    {
        let tx = tx.clone();
        let enabled = Arc::clone(&presence_enabled);
        let reseed = Arc::clone(&presence_reseed);
        std::thread::spawn(move || presence_reader_loop(tx, enabled, reseed));
    }
    // Last presence read from the log, embedded into every snapshot. Starts disabled (opt-in off).
    let mut current_presence = PresenceState::disabled();

    // HWND of the active meeting window plus its cached control elements (see `MeetingCache`).
    let mut cache = MeetingCache::new();
    // The meeting-bound Name handler, rebound as the meeting window changes.
    let mut name_reg: Option<NameReg> = None;
    // Long-lived root window handlers; on failure the loop still runs on the tick + Name handler.
    let window_reg = register_window_handlers(automation, &tx);
    if window_reg.is_none() {
        eprintln!("teamdeck-helper: window event handlers failed to register; relying on the tick");
    }

    let debounce = Duration::from_millis(150);
    // Backstop ticks (see `effective_tick`): the event handlers do the real work, so these only reconcile a missed event — short in a meeting bounds a missed mute/leave, long otherwise keeps the helper near-idle.
    let meeting_tick = Duration::from_secs(5);
    let idle_tick = Duration::from_secs(15);
    // Start "dirty" with a back-dated last-emit so the first snapshot fires immediately.
    let mut dirty = true;
    let mut in_meeting = false;
    let mut last_emit = Instant::now()
        .checked_sub(debounce)
        .unwrap_or_else(Instant::now);

    loop {
        if should_emit(dirty, last_emit.elapsed(), debounce) {
            match emit_snapshot(
                automation,
                &mut cache,
                &mut name_reg,
                &tx,
                &current_presence,
            ) {
                None => break, // stdout pipe broken: parent gone.
                Some(im) => {
                    in_meeting = im;
                    last_emit = Instant::now();
                    dirty = false;
                }
            }
        }
        let tick = effective_tick(in_meeting, meeting_tick, idle_tick);
        let wait = loop_wait(dirty, last_emit.elapsed(), debounce, tick);
        match rx.recv_timeout(wait) {
            Ok(Msg::Cmd(line)) => {
                // The opt-in gate is a serve-state flag, not a UIA control action, so handle it here rather than in `route()`/`handle_command`.
                if let Some(on) = parse_log_reading_cmd(&line) {
                    if on {
                        // Fresh seed on every "on", but reset the shown value to "seeking" only on a real off->on transition, so a redundant "on" doesn't flash unknown (the reseed re-reports the current value).
                        let was_off = !presence_enabled.swap(true, Ordering::Relaxed);
                        presence_reseed.store(true, Ordering::Relaxed);
                        if was_off {
                            current_presence = PresenceState::seeking();
                        }
                    } else {
                        presence_enabled.store(false, Ordering::Relaxed);
                        current_presence = PresenceState::disabled();
                    }
                    if !emit_line(&result_line(
                        "set-log-reading",
                        Some(if on { "on" } else { "off" }),
                        true,
                    )) {
                        break;
                    }
                    dirty = true;
                } else {
                    match handle_command(automation, &mut cache, &line, &tx) {
                        Handled::Stop => break, // stdout pipe broken: parent gone.
                        // Flyout: its worker emits the post-settle snapshot, so don't snapshot mid-rebuild here.
                        Handled::Go { snapshot } => {
                            if snapshot {
                                dirty = true;
                            }
                        }
                    }
                }
            }
            Ok(Msg::Ping) => dirty = true,
            Ok(Msg::Presence(p)) => {
                // Ignore a stale read that lands just after opt-out.
                if presence_enabled.load(Ordering::Relaxed) {
                    current_presence = PresenceState::from_value(p);
                    dirty = true;
                }
            }
            Ok(Msg::Result(line)) => {
                if !emit_line(&line) {
                    break;
                }
                dirty = true;
            }
            Ok(Msg::Eof) => break, // stdin closed: parent gone.
            // Timeout = the adaptive backstop tick, or the debounce window elapsing: resnapshot either way.
            Err(mpsc::RecvTimeoutError::Timeout) => dirty = true,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // Stop new callbacks, then exit hard so an in-flight RPC callback can't race the COM teardown.
    let _ = automation.remove_all_event_handlers();
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_line_is_byte_stable() {
        // The bytes are locked so a refactor can't silently change the wire result contract (serde_json sorts keys: arg, cmd, ok, type).
        assert_eq!(
            result_line("toggle-mute", None, true),
            r#"{"arg":null,"cmd":"toggle-mute","ok":true,"type":"result"}"#
        );
        assert_eq!(
            result_line("react", Some("like"), false),
            r#"{"arg":"like","cmd":"react","ok":false,"type":"result"}"#
        );
    }

    #[test]
    fn should_emit_requires_dirty_and_debounce_elapsed() {
        let d = Duration::from_millis(150);
        assert!(
            !should_emit(false, Duration::from_secs(10), d),
            "clean: never emit"
        );
        assert!(
            !should_emit(true, Duration::from_millis(100), d),
            "dirty but still within the debounce window"
        );
        assert!(
            should_emit(true, Duration::from_millis(150), d),
            "dirty and the debounce has elapsed"
        );
        assert!(should_emit(true, Duration::from_millis(300), d));
    }

    #[test]
    fn loop_wait_debounces_when_dirty_else_idles() {
        let d = Duration::from_millis(150);
        let t = Duration::from_secs(1);
        assert_eq!(
            loop_wait(false, Duration::ZERO, d, t),
            t,
            "clean: wait the idle tick"
        );
        assert_eq!(loop_wait(false, Duration::from_secs(9), d, t), t);
        assert_eq!(
            loop_wait(true, Duration::from_millis(40), d, t),
            Duration::from_millis(110),
            "dirty: wait out the remaining debounce"
        );
        assert_eq!(
            loop_wait(true, Duration::from_millis(200), d, t),
            Duration::ZERO,
            "dirty and overdue: emit on the next loop without sleeping"
        );
    }

    #[test]
    fn effective_tick_is_short_in_meeting_and_long_otherwise() {
        let meeting = Duration::from_secs(5);
        let idle = Duration::from_secs(15);
        assert_eq!(
            effective_tick(true, meeting, idle),
            meeting,
            "in a meeting: short backstop bounds a missed mute/leave"
        );
        assert_eq!(
            effective_tick(false, meeting, idle),
            idle,
            "out of a meeting: long backstop, events catch a meeting starting"
        );
    }
}
