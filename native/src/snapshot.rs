use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Coarse Teams availability, read language-independently from the New Teams log's `UserPresenceAction`
/// line. `Unknown` covers "not read yet", "opt-in off", "Teams not running" and the log's own
/// `PresenceUnknown` token. Activity variants (Presenting/OutOfOffice/...) are not in the coarse log token.
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

/// The presence field of the snapshot. `source` is one of the fixed strings `teams-log` / `disabled`
/// (the plugin also recognises `none` for an older helper) -- never raw log text -- so no log content
/// can reach the wire via this field.
#[derive(Serialize, Clone)]
pub(crate) struct PresenceState {
    pub(crate) value: Presence,
    pub(crate) known: bool,
    source: String,
}

impl PresenceState {
    /// Opt-in off: the helper reads no log.
    pub(crate) fn disabled() -> Self {
        PresenceState {
            value: Presence::Unknown,
            known: false,
            source: "disabled".into(),
        }
    }

    /// Opt-in on but nothing read yet (seeding).
    pub(crate) fn seeking() -> Self {
        PresenceState {
            value: Presence::Unknown,
            known: false,
            source: "teams-log".into(),
        }
    }

    /// A value read from the log. `known` is false for `Unknown` so the UI renders "unavailable".
    pub(crate) fn from_value(p: Presence) -> Self {
        PresenceState {
            value: p,
            known: p != Presence::Unknown,
            source: "teams-log".into(),
        }
    }
}

#[derive(Serialize)]
pub(crate) struct WindowInfo {
    pub(crate) pid: u32,
    pub(crate) name: String,
}

/// Snapshot contract: one JSON line per tick. `teamsRunning`/`inMeeting`/`signals`/`presence` drive the plugin; the rest are diagnostic.
#[derive(Serialize)]
pub(crate) struct Snapshot {
    pub(crate) schema: u32,
    pub(crate) ts: u128,
    #[serde(rename = "teamsRunning")]
    pub(crate) teams_running: bool,
    #[serde(rename = "inMeeting")]
    pub(crate) in_meeting: bool,
    pub(crate) window: Option<WindowInfo>,
    pub(crate) signals: Signals,
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
        // Presence is a camelCase enum string plus its known flag and a fixed source token.
        assert_eq!(v["presence"]["value"], serde_json::json!("doNotDisturb"));
        assert_eq!(v["presence"]["known"], serde_json::json!(true));
        assert_eq!(v["presence"]["source"], serde_json::json!("teams-log"));
    }

    #[test]
    fn presence_state_known_flag_and_sources() {
        // Unknown is never "known" (renders unavailable); a real value is.
        assert!(!PresenceState::from_value(Presence::Unknown).known);
        assert!(PresenceState::from_value(Presence::Busy).known);
        // The three fixed source tokens the plugin distinguishes; never raw log text.
        assert_eq!(PresenceState::disabled().source, "disabled");
        assert_eq!(PresenceState::seeking().source, "teams-log");
        assert_eq!(
            PresenceState::from_value(Presence::Away).source,
            "teams-log"
        );
    }

    #[test]
    fn presence_serialises_as_camel_case() {
        let v = serde_json::to_value(PresenceState::from_value(Presence::BeRightBack)).unwrap();
        assert_eq!(v["value"], serde_json::json!("beRightBack"));
        assert_eq!(v["known"], serde_json::json!(true));
    }
}
