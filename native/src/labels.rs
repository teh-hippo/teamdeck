use crate::snapshot::{known, Signal};
use windows::core::w;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_QWORD};

/// Localisation seam: lower-case Name substrings that reveal mic/camera state. More specific needle first ("unmute" before "mute").
pub(crate) struct StateLabel {
    needle: &'static str,
    value: bool,
}

/// Mic button Name is the action verb: an "unmute" verb means you are muted; "mute" means live.
pub(crate) const MUTE_LABELS: &[StateLabel] = &[
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
pub(crate) const CAMERA_LABELS: &[StateLabel] = &[
    StateLabel {
        needle: "camera off",
        value: true,
    },
    StateLabel {
        needle: "camera on",
        value: false,
    },
];

/// Raise-hand button Name is the action verb: a "lower" verb means the hand is raised, a "raise"
/// verb means it is lowered. Order matters: "raised" contains "raise", so the "lower" needle must be
/// tested first, or a label mentioning "raised" could be misread as lowered.
pub(crate) const HAND_LABELS: &[StateLabel] = &[
    StateLabel {
        needle: "lower",
        value: true,
    },
    StateLabel {
        needle: "raise",
        value: false,
    },
];

/// First label whose needle is in `name` (case-insensitive); None if none match.
fn match_label(name: &str, labels: &[StateLabel]) -> Option<bool> {
    let n = name.to_lowercase();
    labels
        .iter()
        .find(|l| n.contains(l.needle))
        .map(|l| l.value)
}

/// Language-independent camera read from Teams' OS webcam privacy record: LastUsedTimeStop==0 => camera on. None when unreadable.
pub(crate) fn teams_webcam_in_use() -> Option<bool> {
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

/// Maps a control's localised Name to a Signal; an unrecognised label is tagged `uia-label?:<name>` for diagnostics.
pub(crate) fn label_signal(name: &str, labels: &[StateLabel]) -> Signal {
    match match_label(name, labels) {
        Some(v) => known(v, "uia-label"),
        None => Signal {
            value: None,
            available: false,
            source: format!("uia-label?:{name}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mute_label_reads_the_action_verb() {
        assert_eq!(
            match_label("Unmute mic", MUTE_LABELS),
            Some(true),
            "Unmute => muted"
        );
        assert_eq!(
            match_label("Mute mic", MUTE_LABELS),
            Some(false),
            "Mute => unmuted"
        );
        assert_eq!(match_label("Microphone", MUTE_LABELS), None);
    }

    #[test]
    fn label_matching_is_case_insensitive_and_order_aware() {
        // The seam matches case-insensitively, so a localised label in any casing still resolves.
        assert_eq!(match_label("UNMUTE MIC", MUTE_LABELS), Some(true));
        assert_eq!(match_label("unmute mic", MUTE_LABELS), Some(true));
        // "unmute" contains "mute": the more specific needle must win, never collapse to unmuted.
        assert_eq!(
            match_label("Unmute", MUTE_LABELS),
            Some(true),
            "must not match the 'mute' needle first"
        );
        assert_eq!(match_label("turn camera on", CAMERA_LABELS), Some(false));
    }

    #[test]
    fn camera_label_is_case_insensitive() {
        assert_eq!(
            match_label("Turn camera off", CAMERA_LABELS),
            Some(true),
            "off label => camera on"
        );
        assert_eq!(match_label("TURN CAMERA OFF", CAMERA_LABELS), Some(true));
        assert_eq!(
            match_label("Turn camera on", CAMERA_LABELS),
            Some(false),
            "on label => camera off"
        );
        assert_eq!(match_label("No control here", CAMERA_LABELS), None);
    }

    #[test]
    fn hand_label_reads_the_action_verb() {
        // The Name is the action verb: "Lower your hand" => raised, "Raise your hand" => lowered.
        assert_eq!(match_label("Lower your hand", HAND_LABELS), Some(true));
        assert_eq!(match_label("Raise your hand", HAND_LABELS), Some(false));
        // Case-insensitive, so a localised label in any casing still resolves.
        assert_eq!(match_label("LOWER YOUR HAND", HAND_LABELS), Some(true));
        // Order is load-bearing: "raised" contains "raise", so a label mentioning "raised" must not
        // collapse to lowered; the "lower" needle is tested first.
        assert_eq!(
            match_label("Hand raised, lower your hand", HAND_LABELS),
            Some(true)
        );
        assert_eq!(match_label("Microphone", HAND_LABELS), None);
    }
}
