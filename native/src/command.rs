use crate::labels::{
    control_signal, is_actuable, StateLabel, CAMERA_LABELS, HAND_LABELS, MUTE_LABELS,
};
use crate::meeting::{
    actuate, locate_control, meeting_active, react_id, run_flyout_action, MeetingCache,
};
use crate::serve::Msg;
use crate::snapshot::{now_ms, SCHEMA};
use serde::{Deserialize, Serialize};
use std::sync::mpsc::{Receiver, Sender, SyncSender, TrySendError};
use std::time::{Duration, Instant};
use uiautomation::UIAutomation;

const LEAVE_TIMEOUT: Duration = Duration::from_secs(2);
const READY_TIMEOUT: Duration = Duration::from_millis(300);
const CONFIRM_POLL: Duration = Duration::from_millis(25);
const HAND_RETRY_AFTER: Duration = Duration::from_millis(600);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCommand {
    id: u64,
    cmd: String,
    target: Option<bool>,
    arg: Option<String>,
}

pub(crate) struct Work {
    command: WireCommand,
    queued_at: Instant,
}

#[derive(Debug, PartialEq, Eq)]
enum ToggleKind {
    Mute,
    Camera,
    Hand,
}

#[derive(Debug, PartialEq, Eq)]
enum Action<'a> {
    Set(ToggleKind, bool),
    Leave,
    React(&'a str),
    Noop,
}

impl ToggleKind {
    fn control_id(&self) -> &'static str {
        match self {
            Self::Mute => "microphone-button",
            Self::Camera => "video-button",
            Self::Hand => "raisehands-button",
        }
    }

    fn labels(&self) -> &'static [StateLabel] {
        match self {
            Self::Mute => MUTE_LABELS,
            Self::Camera => CAMERA_LABELS,
            Self::Hand => HAND_LABELS,
        }
    }

    fn confirm_timeout(&self) -> Duration {
        match self {
            Self::Hand => Duration::from_millis(2_000),
            Self::Mute | Self::Camera => Duration::from_millis(750),
        }
    }

    fn signal(&self, element: &uiautomation::UIElement) -> crate::snapshot::Signal {
        control_signal(element, self.labels())
    }
}

fn route(command: &WireCommand) -> Action<'_> {
    match command.cmd.as_str() {
        "set-mute" => command
            .target
            .map(|target| Action::Set(ToggleKind::Mute, target))
            .unwrap_or(Action::Noop),
        "set-camera" => command
            .target
            .map(|target| Action::Set(ToggleKind::Camera, target))
            .unwrap_or(Action::Noop),
        "set-hand" => command
            .target
            .map(|target| Action::Set(ToggleKind::Hand, target))
            .unwrap_or(Action::Noop),
        "leave" => Action::Leave,
        "react" => command
            .arg
            .as_deref()
            .and_then(react_id)
            .map(Action::React)
            .unwrap_or(Action::Noop),
        _ => Action::Noop,
    }
}

struct Outcome {
    ok: bool,
    observed: Option<bool>,
    state_source: Option<String>,
    reason: Option<&'static str>,
    action_ms: u128,
    confirm_ms: u128,
    retries: u8,
}

impl Outcome {
    fn failed(reason: &'static str) -> Self {
        Self {
            ok: false,
            observed: None,
            state_source: None,
            reason: Some(reason),
            action_ms: 0,
            confirm_ms: 0,
            retries: 0,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultMessage<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    schema: u32,
    ts: u128,
    id: u64,
    cmd: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    observed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state_source: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'a str>,
    queue_ms: u128,
    action_ms: u128,
    confirm_ms: u128,
    total_ms: u128,
    retries: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedMessage<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    schema: u32,
    ts: u128,
    id: u64,
    cmd: &'a str,
    queue_ms: u128,
}

fn started_line(command: &WireCommand, queue_ms: u128) -> String {
    serde_json::to_string(&StartedMessage {
        kind: "started",
        schema: SCHEMA,
        ts: now_ms(),
        id: command.id,
        cmd: &command.cmd,
        queue_ms,
    })
    .unwrap_or_default()
}

fn result_line(command: &WireCommand, outcome: &Outcome, queue_ms: u128, total_ms: u128) -> String {
    serde_json::to_string(&ResultMessage {
        kind: "result",
        schema: SCHEMA,
        ts: now_ms(),
        id: command.id,
        cmd: &command.cmd,
        ok: outcome.ok,
        target: command.target,
        observed: outcome.observed,
        state_source: outcome.state_source.as_deref(),
        reason: outcome.reason,
        queue_ms,
        action_ms: outcome.action_ms,
        confirm_ms: outcome.confirm_ms,
        total_ms,
        retries: outcome.retries,
    })
    .unwrap_or_else(|_| {
        format!(
            r#"{{"type":"result","schema":{SCHEMA},"id":{},"cmd":"unknown","ok":false,"reason":"serialise-failed","queueMs":0,"actionMs":0,"confirmMs":0,"totalMs":0}}"#,
            command.id
        )
    })
}

fn execute_set(
    automation: &UIAutomation,
    cache: &mut MeetingCache,
    kind: ToggleKind,
    target: bool,
) -> Outcome {
    let aid = kind.control_id();
    let confirm_timeout = kind.confirm_timeout();
    let ready_started = Instant::now();
    let mut failure = "control-missing";
    let (element, initial, current) = loop {
        if let Some(element) = locate_control(automation, cache, aid) {
            let signal = kind.signal(&element);
            failure = if signal.available {
                "state-unresolved"
            } else {
                "control-unavailable"
            };
            if signal.available {
                if let Some(current) = signal.value {
                    break (element, signal, current);
                }
            }
            cache.drop_elem(aid);
        }
        if ready_started.elapsed() >= READY_TIMEOUT {
            return Outcome::failed(failure);
        }
        std::thread::sleep(CONFIRM_POLL);
    };
    if current == target {
        return Outcome {
            ok: true,
            observed: Some(current),
            state_source: Some(initial.source),
            reason: Some("already-set"),
            action_ms: 0,
            confirm_ms: 0,
            retries: 0,
        };
    }

    let action_started = Instant::now();
    if !actuate(&element) {
        cache.drop_elem(aid);
        return Outcome {
            observed: Some(current),
            state_source: Some(initial.source),
            action_ms: action_started.elapsed().as_millis(),
            ..Outcome::failed("actuation-failed")
        };
    }
    let mut action_ms = action_started.elapsed().as_millis();
    cache.drop_elem(aid);
    let confirm_started = Instant::now();
    let mut observed = Some(current);
    let mut source = Some(initial.source);
    let mut retries = 0;
    while confirm_started.elapsed() < confirm_timeout {
        std::thread::sleep(CONFIRM_POLL);
        let Some(element) = locate_control(automation, cache, aid) else {
            continue;
        };
        let signal = kind.signal(&element);
        observed = signal.value;
        source = Some(signal.source);
        if observed == Some(target) {
            return Outcome {
                ok: true,
                observed,
                state_source: source,
                reason: None,
                action_ms,
                confirm_ms: confirm_started.elapsed().as_millis(),
                retries,
            };
        }
        if kind == ToggleKind::Hand
            && retries < 2
            && confirm_started.elapsed() >= HAND_RETRY_AFTER * (u32::from(retries) + 1)
            && observed == Some(current)
            && source.as_deref() == Some("uia-full-description")
        {
            let retry_started = Instant::now();
            let _ = actuate(&element);
            retries += 1;
            action_ms += retry_started.elapsed().as_millis();
        }
        cache.drop_elem(aid);
    }
    Outcome {
        ok: false,
        observed,
        state_source: source,
        reason: Some("confirmation-timeout"),
        action_ms,
        confirm_ms: confirm_started.elapsed().as_millis(),
        retries,
    }
}

fn execute_leave(automation: &UIAutomation, cache: &mut MeetingCache) -> Outcome {
    let Some(element) = locate_control(automation, cache, "hangup-button") else {
        return Outcome::failed("control-missing");
    };
    if !is_actuable(&element) {
        return Outcome::failed("control-unavailable");
    }
    let action_started = Instant::now();
    if !actuate(&element) {
        cache.drop_elem("hangup-button");
        return Outcome {
            action_ms: action_started.elapsed().as_millis(),
            ..Outcome::failed("actuation-failed")
        };
    }
    let action_ms = action_started.elapsed().as_millis();
    let confirm_started = Instant::now();
    while confirm_started.elapsed() < LEAVE_TIMEOUT {
        std::thread::sleep(CONFIRM_POLL);
        cache.clear_controls();
        if !meeting_active(automation, cache) {
            return Outcome {
                ok: true,
                observed: Some(false),
                state_source: Some("uia-window".into()),
                reason: None,
                action_ms,
                confirm_ms: confirm_started.elapsed().as_millis(),
                retries: 0,
            };
        }
    }
    Outcome {
        ok: false,
        observed: Some(true),
        state_source: Some("uia-window".into()),
        reason: Some("confirmation-timeout"),
        action_ms,
        confirm_ms: confirm_started.elapsed().as_millis(),
        retries: 0,
    }
}

fn execute_reaction(automation: &UIAutomation, cache: &mut MeetingCache, aid: &str) -> Outcome {
    let action_started = Instant::now();
    let ok = run_flyout_action(automation, cache, aid);
    Outcome {
        ok,
        observed: None,
        state_source: None,
        reason: (!ok).then_some("actuation-failed"),
        action_ms: action_started.elapsed().as_millis(),
        confirm_ms: 0,
        retries: 0,
    }
}

fn execute(automation: &UIAutomation, cache: &mut MeetingCache, command: &WireCommand) -> Outcome {
    match route(command) {
        Action::Set(kind, target) => execute_set(automation, cache, kind, target),
        Action::Leave => execute_leave(automation, cache),
        Action::React(aid) => execute_reaction(automation, cache, aid),
        Action::Noop => Outcome::failed("invalid-command"),
    }
}

pub(crate) fn enqueue_command(line: &str, tx: &SyncSender<Work>) -> Option<String> {
    let command = serde_json::from_str::<WireCommand>(line.trim()).ok()?;
    let work = Work {
        command,
        queued_at: Instant::now(),
    };
    match tx.try_send(work) {
        Ok(()) => None,
        Err(TrySendError::Full(work)) => {
            let outcome = Outcome::failed("queue-full");
            Some(result_line(&work.command, &outcome, 0, 0))
        }
        Err(TrySendError::Disconnected(work)) => {
            let outcome = Outcome::failed("worker-unavailable");
            Some(result_line(&work.command, &outcome, 0, 0))
        }
    }
}

pub(crate) fn action_worker_loop(rx: Receiver<Work>, tx: Sender<Msg>) {
    let automation = UIAutomation::new().ok();
    let mut cache = MeetingCache::new();
    while let Ok(work) = rx.recv() {
        let queue_ms = work.queued_at.elapsed().as_millis();
        if tx
            .send(Msg::Started(started_line(&work.command, queue_ms)))
            .is_err()
        {
            break;
        }
        let outcome = match &automation {
            Some(automation) => execute(automation, &mut cache, &work.command),
            None => Outcome::failed("uia-initialisation-failed"),
        };
        let total_ms = work.queued_at.elapsed().as_millis();
        if tx
            .send(Msg::Result(result_line(
                &work.command,
                &outcome,
                queue_ms,
                total_ms,
            )))
            .is_err()
        {
            break;
        }
    }
}

/// Detects the presence opt-in command `{"cmd":"set-log-reading","arg":"on|off"}`.
pub(crate) fn parse_log_reading_cmd(line: &str) -> Option<bool> {
    let cmd = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    if cmd.get("cmd").and_then(|value| value.as_str())? != "set-log-reading" {
        return None;
    }
    match cmd.get("arg").and_then(|value| value.as_str())? {
        "on" => Some(true),
        "off" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(cmd: &str, target: Option<bool>, arg: Option<&str>) -> WireCommand {
        WireCommand {
            id: 7,
            cmd: cmd.into(),
            target,
            arg: arg.map(str::to_string),
        }
    }

    #[test]
    fn route_requires_targets_for_state_commands() {
        assert_eq!(
            route(&command("set-mute", Some(true), None)),
            Action::Set(ToggleKind::Mute, true)
        );
        assert_eq!(
            route(&command("set-camera", Some(false), None)),
            Action::Set(ToggleKind::Camera, false)
        );
        assert_eq!(
            route(&command("set-hand", Some(true), None)),
            Action::Set(ToggleKind::Hand, true)
        );
        assert_eq!(route(&command("set-hand", None, None)), Action::Noop);
        assert_eq!(
            route(&command("react", None, Some("like"))),
            Action::React("like-button")
        );
        assert_eq!(route(&command("react", None, Some("nope"))), Action::Noop);
        assert_eq!(HAND_RETRY_AFTER, Duration::from_millis(600));
        assert_eq!(
            ToggleKind::Hand.confirm_timeout(),
            Duration::from_millis(2_000)
        );
    }

    #[test]
    fn result_line_contains_the_versioned_timing_contract() {
        let command = command("set-hand", Some(true), None);
        let line = result_line(
            &command,
            &Outcome {
                ok: true,
                observed: Some(true),
                state_source: Some("uia-aria".into()),
                reason: None,
                action_ms: 4,
                confirm_ms: 38,
                retries: 1,
            },
            2,
            44,
        );
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["type"], "result");
        assert_eq!(value["schema"], SCHEMA);
        assert_eq!(value["id"], 7);
        assert_eq!(value["target"], true);
        assert_eq!(value["observed"], true);
        assert_eq!(value["stateSource"], "uia-aria");
        assert_eq!(value["queueMs"], 2);
        assert_eq!(value["totalMs"], 44);
        assert_eq!(value["retries"], 1);
    }

    #[test]
    fn started_line_marks_when_a_queued_command_becomes_active() {
        let value: serde_json::Value =
            serde_json::from_str(&started_line(&command("set-hand", Some(true), None), 17))
                .unwrap();
        assert_eq!(value["type"], "started");
        assert_eq!(value["schema"], SCHEMA);
        assert_eq!(value["id"], 7);
        assert_eq!(value["queueMs"], 17);
    }

    #[test]
    fn parse_log_reading_cmd_detects_only_the_opt_in() {
        assert_eq!(
            parse_log_reading_cmd(r#"{"cmd":"set-log-reading","arg":"on"}"#),
            Some(true)
        );
        assert_eq!(
            parse_log_reading_cmd(r#"{"cmd":"set-log-reading","arg":"off"}"#),
            Some(false)
        );
        assert_eq!(
            parse_log_reading_cmd(r#"{"cmd":"set-log-reading","arg":"maybe"}"#),
            None
        );
        assert_eq!(parse_log_reading_cmd(r#"{"cmd":"set-mute"}"#), None);
    }
}
