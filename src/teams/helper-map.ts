import type { MeetingPermissions, MeetingState, TeamsSnapshot } from "./types";

/** One signal as reported by the UIA helper (`value` is `null` when unknown). */
export type HelperSignal = { value: boolean | null; available: boolean; source: string };

/** A snapshot line emitted by the helper's `serve` mode (see `native/` and `agent/specs/helper.md`). */
export type HelperSnapshot = {
	type?: string;
	teamsRunning: boolean;
	inMeeting: boolean;
	window: { pid: number; name: string } | null;
	signals: {
		mute: HelperSignal;
		camera: HelperSignal;
		hand: HelperSignal;
		sharing: HelperSignal;
		recording: HelperSignal;
		unread: HelperSignal;
	};
};

/** The snapshot used when the helper is not running. */
export const HELPER_DISCONNECTED: TeamsSnapshot = {
	connected: false,
	state: {},
	permissions: {},
	availability: {},
};

/** A signal's value, or `undefined` when the helper cannot read it (so it renders "unknown"). */
function known(sig: HelperSignal): boolean | undefined {
	return sig.available ? (sig.value ?? undefined) : undefined;
}

/**
 * Maps a helper snapshot onto the plugin's `TeamsSnapshot`.
 *
 * The legacy third-party API supplied a `meetingPermissions` object and full `meetingState`; the
 * UIA helper has neither. So permissions are **synthesized** from what the helper can observe/act
 * on (panel finding B1), and an **availability** map marks fields the helper cannot read so keys
 * render "unknown" instead of a fake on/off (B2). `value: true` means muted / camera-on /
 * hand-raised / sharing, matching `MeetingState`.
 */
export function mapHelperSnapshot(h: HelperSnapshot): TeamsSnapshot {
	const s = h.signals;
	const inMeeting = h.inMeeting;

	const state: Partial<MeetingState> = {
		isInMeeting: inMeeting,
		isMuted: known(s.mute),
		isVideoOn: known(s.camera),
		isHandRaised: known(s.hand),
		isSharing: known(s.sharing),
		isRecordingOn: known(s.recording),
		isBackgroundBlurred: undefined,
		hasUnreadMessages: known(s.unread),
	};

	// A key is actionable only in a meeting; mute/camera also require that the helper can read the
	// control. Hand/leave/react are control-only (state may be unknown) but available in a meeting.
	const permissions: Partial<MeetingPermissions> = {
		canToggleMute: inMeeting && s.mute.available,
		canToggleVideo: inMeeting && s.camera.available,
		canToggleHand: inMeeting,
		canToggleBlur: false,
		canLeave: inMeeting,
		canReact: inMeeting,
	};

	const availability: Partial<Record<keyof MeetingState, boolean>> = {
		isInMeeting: true,
		isMuted: s.mute.available,
		isVideoOn: s.camera.available,
		isHandRaised: s.hand.available,
		isSharing: s.sharing.available,
		isRecordingOn: s.recording.available,
		isBackgroundBlurred: false,
		hasUnreadMessages: s.unread.available,
	};

	return { connected: h.teamsRunning, state, permissions, availability };
}
