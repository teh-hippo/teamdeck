use crate::command::{action_worker_loop, enqueue_command, parse_log_reading_cmd};
use crate::handlers::{reconcile_name_handler, reconcile_window_handlers, NameReg};
use crate::labels::{
    control_signal, is_actuable, teams_webcam_in_use, CAMERA_LABELS, HAND_LABELS, MUTE_LABELS,
};
use crate::meeting::{cached_elem, locate_meeting, top_cache_request, MeetingCache};
use crate::presence::presence_reader_loop;
use crate::snapshot::{
    known, now_ms, Controls, Presence, PresenceState, Signal, Signals, Snapshot, SCHEMA,
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
        schema: SCHEMA,
        ts: now_ms(),
        teams_running: false,
        in_meeting: false,
        signals: Signals {
            mute: Signal::unknown(),
            camera: Signal::unknown(),
            hand: Signal::unknown(),
            sharing: Signal::unknown(),
        },
        controls: Controls {
            leave: false,
            react: false,
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
        match cached_elem(automation, cache, &m, "microphone-button") {
            Some(mic) => {
                snap.in_meeting = true;
                snap.teams_running = true;
                snap.signals.mute = control_signal(&mic, MUTE_LABELS);
                snap.signals.camera = match cached_elem(automation, cache, &m, "video-button") {
                    Some(video) => control_signal(&video, CAMERA_LABELS),
                    None => Signal::unknown(),
                };
                snap.signals.hand = match cached_elem(automation, cache, &m, "raisehands-button") {
                    Some(hand) => control_signal(&hand, HAND_LABELS),
                    None => Signal::unknown(),
                };
                snap.controls.leave = cached_elem(automation, cache, &m, "hangup-button")
                    .is_some_and(|element| is_actuable(&element));
                snap.controls.react = cached_elem(automation, cache, &m, "reaction-menu-button")
                    .is_some_and(|element| is_actuable(&element));
                snap.signals.sharing = known(sharing, "uia-window");
            }
            None => cache.rebind(None),
        }
    }

    if !snap.teams_running && snap.presence.value != Presence::Unknown {
        snap.presence.value = Presence::Unknown;
        snap.presence.known = false;
    }

    snap
}

/// Messages multiplexed by the service loop.
pub(crate) enum Msg {
    Cmd(String),
    Ping,
    Started(String),
    Result(String),
    Presence(Presence),
    Eof,
}

const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Sender<Msg>>();
};

pub(crate) fn emit_line(s: &str) -> bool {
    let out = std::io::stdout();
    let mut h = out.lock();
    writeln!(h, "{s}").and_then(|_| h.flush()).is_ok()
}

fn heartbeat_line() -> String {
    serde_json::json!({ "type": "heartbeat", "schema": SCHEMA, "ts": now_ms() }).to_string()
}

/// Emits one snapshot line and reconciles the state-change handler.
fn emit_snapshot(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    name_reg: &mut Option<NameReg>,
    retired_name_regs: &mut Vec<NameReg>,
    tx: &Sender<Msg>,
    presence: &PresenceState,
) -> Option<bool> {
    let snap = build_snapshot(automation, cache, presence);
    let in_meeting = snap.in_meeting;
    reconcile_name_handler(
        automation,
        name_reg,
        retired_name_regs,
        cache.hwnd,
        in_meeting,
        tx,
    );
    let ok = match serde_json::to_value(&snap) {
        Ok(mut value) => {
            value["type"] = serde_json::json!("snapshot");
            emit_line(&value.to_string())
        }
        Err(_) => true,
    };
    ok.then_some(in_meeting)
}

fn should_emit(dirty: bool, since_emit: Duration, debounce: Duration) -> bool {
    dirty && since_emit >= debounce
}

fn loop_wait(dirty: bool, since_emit: Duration, debounce: Duration, tick: Duration) -> Duration {
    if dirty {
        debounce.saturating_sub(since_emit)
    } else {
        tick
    }
}

fn effective_tick(in_meeting: bool, meeting_tick: Duration, idle_tick: Duration) -> Duration {
    if in_meeting {
        meeting_tick
    } else {
        idle_tick
    }
}

fn timeout_requires_snapshot(dirty: bool, since_emit: Duration, tick: Duration) -> bool {
    dirty || since_emit >= tick
}

fn camera_reader_loop(tx: Sender<Msg>) {
    let mut previous = teams_webcam_in_use();
    loop {
        std::thread::sleep(Duration::from_millis(250));
        let current = teams_webcam_in_use();
        if current != previous {
            previous = current;
            if tx.send(Msg::Ping).is_err() {
                break;
            }
        }
    }
}

/// Persistent service: streams snapshots, heartbeats and command results on stdout.
pub(crate) fn serve(automation: &UIAutomation) {
    let (tx, rx) = mpsc::channel::<Msg>();
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                match line {
                    Ok(line) => {
                        if tx.send(Msg::Cmd(line)).is_err() {
                            break;
                        }
                    }
                    Err(error) if error.kind() == ErrorKind::InvalidData => continue,
                    Err(_) => break,
                }
            }
            let _ = tx.send(Msg::Eof);
        });
    }

    let (action_tx, action_rx) = mpsc::sync_channel(8);
    {
        let tx = tx.clone();
        std::thread::spawn(move || action_worker_loop(action_rx, tx));
    }
    {
        let tx = tx.clone();
        std::thread::spawn(move || camera_reader_loop(tx));
    }

    let presence_enabled = Arc::new(AtomicBool::new(false));
    let presence_reseed = Arc::new(AtomicBool::new(false));
    {
        let tx = tx.clone();
        let enabled = Arc::clone(&presence_enabled);
        let reseed = Arc::clone(&presence_reseed);
        std::thread::spawn(move || presence_reader_loop(tx, enabled, reseed));
    }
    let mut current_presence = PresenceState::disabled();
    let mut cache = MeetingCache::new();
    let mut name_reg: Option<NameReg> = None;
    let mut window_reg = None;
    let mut retired_name_regs = Vec::new();
    let mut retired_window_regs = Vec::new();
    let mut window_reg_attempts = 0;
    reconcile_window_handlers(
        automation,
        &mut window_reg,
        &mut retired_window_regs,
        &mut window_reg_attempts,
        &tx,
    );
    if window_reg.is_none() {
        eprintln!("teamdeck-helper: window event handlers failed to register; retrying");
    }

    let debounce = Duration::from_millis(150);
    let heartbeat = Duration::from_secs(1);
    let meeting_tick = Duration::from_secs(5);
    let idle_tick = Duration::from_secs(15);
    let mut dirty = true;
    let mut in_meeting = false;
    let mut last_emit = Instant::now()
        .checked_sub(debounce)
        .unwrap_or_else(Instant::now);
    let mut last_heartbeat = Instant::now()
        .checked_sub(heartbeat)
        .unwrap_or_else(Instant::now);

    loop {
        if last_heartbeat.elapsed() >= heartbeat {
            if !emit_line(&heartbeat_line()) {
                break;
            }
            last_heartbeat = Instant::now();
        }
        if should_emit(dirty, last_emit.elapsed(), debounce) {
            match emit_snapshot(
                automation,
                &mut cache,
                &mut name_reg,
                &mut retired_name_regs,
                &tx,
                &current_presence,
            ) {
                None => break,
                Some(active) => {
                    in_meeting = active;
                    last_emit = Instant::now();
                    dirty = false;
                }
            }
            if reconcile_window_handlers(
                automation,
                &mut window_reg,
                &mut retired_window_regs,
                &mut window_reg_attempts,
                &tx,
            ) {
                eprintln!(
                    "teamdeck-helper: window event handlers failed after 3 attempts; relying on the tick"
                );
            }
        }
        let tick = effective_tick(in_meeting, meeting_tick, idle_tick);
        let wait = loop_wait(dirty, last_emit.elapsed(), debounce, tick)
            .min(heartbeat.saturating_sub(last_heartbeat.elapsed()));
        match rx.recv_timeout(wait) {
            Ok(Msg::Cmd(line)) => {
                if let Some(on) = parse_log_reading_cmd(&line) {
                    if on {
                        let was_off = !presence_enabled.swap(true, Ordering::Relaxed);
                        presence_reseed.store(true, Ordering::Relaxed);
                        if was_off {
                            current_presence = PresenceState::seeking();
                        }
                    } else {
                        presence_enabled.store(false, Ordering::Relaxed);
                        current_presence = PresenceState::disabled();
                    }
                    dirty = true;
                } else if let Some(result) = enqueue_command(&line, &action_tx) {
                    if !emit_line(&result) {
                        break;
                    }
                    dirty = true;
                }
            }
            Ok(Msg::Ping) => dirty = true,
            Ok(Msg::Started(line)) => {
                if !emit_line(&line) {
                    break;
                }
            }
            Ok(Msg::Presence(p)) => {
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
            Ok(Msg::Eof) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if timeout_requires_snapshot(dirty, last_emit.elapsed(), tick) {
                    dirty = true;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_line_has_the_versioned_contract() {
        let value: serde_json::Value = serde_json::from_str(&heartbeat_line()).unwrap();
        assert_eq!(value["type"], "heartbeat");
        assert_eq!(value["schema"], SCHEMA);
        assert!(value["ts"].is_number());
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

    #[test]
    fn heartbeat_timeout_does_not_force_an_early_snapshot() {
        let tick = Duration::from_secs(5);
        assert!(!timeout_requires_snapshot(
            false,
            Duration::from_secs(1),
            tick
        ));
        assert!(timeout_requires_snapshot(
            false,
            Duration::from_secs(5),
            tick
        ));
        assert!(timeout_requires_snapshot(
            true,
            Duration::from_millis(1),
            tick
        ));
    }
}
