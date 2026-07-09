use crate::meeting::{
    actuate, cached_elem, locate_meeting, react_id, run_flyout_worker, top_teamswebviews,
    MeetingCache,
};
use crate::serve::{emit_line, result_line, Msg};
use std::sync::mpsc::Sender;
use uiautomation::UIAutomation;

/// What a command verb maps to, decided without touching UIA (unit-testable). `Noop` never actuates.
#[derive(Debug, PartialEq, Eq)]
enum Action {
    /// Actuate a single control by AutomationId (mute / camera / leave / raise-hand).
    Toggle(&'static str),
    /// Open the React flyout and actuate an item by AutomationId (reactions).
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
        // Raise-hand is a main-toolbar button (a peer of mic/camera), actuated directly via the focus-free MSAA path (do_default_action) like mute; if Teams moves it back under the React flyout it goes absent and act_toggle surfaces ok:false (a reworked-but-present control could instead no-op silently, as do_default_action reports success).
        "raise-hand" => Action::Toggle("raisehands-button"),
        "react" => match arg.and_then(react_id) {
            Some(id) => Action::Flyout(id),
            None => Action::Noop,
        },
        _ => Action::Noop,
    }
}

/// Actuates a toggle control (mute/camera/leave) on the cached window, re-finding once if it's absent so a press is never silently dropped. Runs inline (DoDefaultAction is fast).
fn act_toggle(automation: &UIAutomation, cache: &mut MeetingCache, aid: &'static str) -> bool {
    // Fast path: a valid cached window actuates with no top-level enumeration (the common in-call case).
    if let Some(m) = locate_meeting(automation, cache, &[]) {
        if let Some(el) = cached_elem(automation, cache, &m, aid) {
            let ok = actuate(&el);
            // Validated element that still didn't actuate (transient rebuild): drop it so the next press/tick re-finds; no in-call retry.
            if !ok {
                cache.drop_elem(aid);
            }
            return ok;
        }
    }
    // Cache empty/stale or control absent: enumerate once and retry against a fresh meeting.
    cache.rebind(None);
    let candidates = top_teamswebviews(automation);
    match locate_meeting(automation, cache, &candidates) {
        Some(m) => cached_elem(automation, cache, &m, aid)
            .map(|el| actuate(&el))
            .unwrap_or(false),
        None => false,
    }
}

/// Outcome of handling one command line, returned to the serve loop.
pub(crate) enum Handled {
    /// Keep serving; `snapshot` requests an immediate post-command snapshot (true for inline toggle/noop, false for flyout).
    Go { snapshot: bool },
    /// The stdout pipe broke (parent gone): stop serving.
    Stop,
}

/// Detects the presence opt-in command `{"cmd":"set-log-reading","arg":"on|off"}`, returning the
/// desired enabled state. `None` for any other line, so normal commands fall through to `handle_command`.
pub(crate) fn parse_log_reading_cmd(line: &str) -> Option<bool> {
    let cmd = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    if cmd.get("cmd").and_then(|v| v.as_str())? != "set-log-reading" {
        return None;
    }
    match cmd.get("arg").and_then(|v| v.as_str())? {
        "on" => Some(true),
        "off" => Some(false),
        _ => None,
    }
}

/// Parses one command line and acts: toggles run inline and emit immediately; flyout actions run on a worker that funnels its result via `Msg::Result`.
pub(crate) fn handle_command(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    line: &str,
    tx: &Sender<Msg>,
) -> Handled {
    let line = line.trim();
    if line.is_empty() {
        return Handled::Go { snapshot: false };
    }
    let Ok(cmd) = serde_json::from_str::<serde_json::Value>(line) else {
        return Handled::Go { snapshot: false };
    };
    let verb = cmd.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
    let arg = cmd.get("arg").and_then(|v| v.as_str());
    match route(verb, arg) {
        Action::Flyout(aid) => {
            let hwnd = cache.hwnd;
            let verb = verb.to_string();
            let arg = arg.map(str::to_string);
            let tx = tx.clone();
            std::thread::spawn(move || {
                let ok = run_flyout_worker(hwnd, aid);
                let _ = tx.send(Msg::Result(result_line(&verb, arg.as_deref(), ok)));
            });
            Handled::Go { snapshot: false }
        }
        Action::Toggle(aid) => {
            if emit_line(&result_line(verb, arg, act_toggle(automation, cache, aid))) {
                Handled::Go { snapshot: true }
            } else {
                Handled::Stop
            }
        }
        Action::Noop => {
            if emit_line(&result_line(verb, arg, false)) {
                Handled::Go { snapshot: true }
            } else {
                Handled::Stop
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            Action::Toggle("raisehands-button")
        );
        assert_eq!(route("react", Some("like")), Action::Flyout("like-button"));
        assert_eq!(
            route("react", Some("surprised")),
            Action::Flyout("surprised-button")
        );
        // Unknown verb and unrecognised reaction collapse to Noop (ok:false, and crucially no stale-cache retry), so a bad command is never mistaken for a stale window or double-act.
        assert_eq!(route("react", Some("nope")), Action::Noop);
        assert_eq!(route("react", None), Action::Noop);
        assert_eq!(route("bogus", None), Action::Noop);
    }

    #[test]
    fn parse_log_reading_cmd_detects_the_opt_in_only() {
        assert_eq!(
            parse_log_reading_cmd(r#"{"cmd":"set-log-reading","arg":"on"}"#),
            Some(true)
        );
        assert_eq!(
            parse_log_reading_cmd(r#"{"cmd":"set-log-reading","arg":"off"}"#),
            Some(false)
        );
        // A bad arg, a different verb, and non-JSON all fall through to the normal command path.
        assert_eq!(
            parse_log_reading_cmd(r#"{"cmd":"set-log-reading","arg":"maybe"}"#),
            None
        );
        assert_eq!(parse_log_reading_cmd(r#"{"cmd":"toggle-mute"}"#), None);
        assert_eq!(parse_log_reading_cmd("not json"), None);
    }
}
