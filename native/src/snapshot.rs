use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const SCHEMA: u32 = 2;

#[derive(Serialize)]
pub(crate) struct Signal {
    pub(crate) value: Option<bool>,
    pub(crate) available: bool,
    pub(crate) source: String,
}

impl Signal {
    pub(crate) fn unknown() -> Self {
        Signal {
            value: None,
            available: false,
            source: "none".into(),
        }
    }
}

#[derive(Serialize)]
pub(crate) struct Signals {
    pub(crate) mute: Signal,
    pub(crate) camera: Signal,
    pub(crate) hand: Signal,
    pub(crate) sharing: Signal,
}

#[derive(Serialize)]
pub(crate) struct Controls {
    pub(crate) leave: bool,
    pub(crate) react: bool,
}

/// Coarse Teams availability, read language-independently from the New Teams log. `Unknown` covers "not read yet", "opt-in off", "Teams not running" and the log's own `PresenceUnknown` token. Activity variants (Presenting/OutOfOffice/...) aren't in the coarse log token.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Presence {
    Available,
    Busy,
    DoNotDisturb,
    BeRightBack,
    Away,
    Offline,
    Unknown,
}

#[derive(Serialize, Clone)]
pub(crate) struct PresenceState {
    pub(crate) value: Presence,
    pub(crate) known: bool,
}

impl PresenceState {
    /// Opt-in off: the helper reads no log.
    pub(crate) fn disabled() -> Self {
        PresenceState {
            value: Presence::Unknown,
            known: false,
        }
    }

    /// Opt-in on but nothing read yet (seeding).
    pub(crate) fn seeking() -> Self {
        PresenceState {
            value: Presence::Unknown,
            known: false,
        }
    }

    /// A value read from the log. `known` is false for `Unknown` so the UI renders "unavailable".
    pub(crate) fn from_value(p: Presence) -> Self {
        PresenceState {
            value: p,
            known: p != Presence::Unknown,
        }
    }
}

/// Snapshot contract: one JSON line per tick.
#[derive(Serialize)]
pub(crate) struct Snapshot {
    pub(crate) schema: u32,
    pub(crate) ts: u128,
    #[serde(rename = "teamsRunning")]
    pub(crate) teams_running: bool,
    #[serde(rename = "inMeeting")]
    pub(crate) in_meeting: bool,
    pub(crate) signals: Signals,
    pub(crate) controls: Controls,
    pub(crate) presence: PresenceState,
}

pub(crate) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub(crate) fn known(value: bool, source: &str) -> Signal {
    Signal {
        value: Some(value),
        available: true,
        source: source.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_serialises_the_wire_contract() {
        let snap = Snapshot {
            schema: SCHEMA,
            ts: 0,
            teams_running: true,
            in_meeting: true,
            signals: Signals {
                mute: known(false, "uia-label"),
                camera: Signal::unknown(),
                hand: Signal::unknown(),
                sharing: known(true, "uia-window"),
            },
            controls: Controls {
                leave: true,
                react: true,
            },
            presence: PresenceState::from_value(Presence::DoNotDisturb),
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
        assert_eq!(v["presence"]["value"], serde_json::json!("doNotDisturb"));
        assert_eq!(v["presence"]["known"], serde_json::json!(true));
    }

    #[test]
    fn presence_state_known_flag() {
        assert!(!PresenceState::from_value(Presence::Unknown).known);
        assert!(PresenceState::from_value(Presence::Busy).known);
    }

    #[test]
    fn presence_serialises_as_camel_case() {
        let v = serde_json::to_value(PresenceState::from_value(Presence::BeRightBack)).unwrap();
        assert_eq!(v["value"], serde_json::json!("beRightBack"));
        assert_eq!(v["known"], serde_json::json!(true));
    }
}
