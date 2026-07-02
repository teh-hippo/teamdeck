import type { MeetingPermissions, MeetingState, TeamsSnapshot } from "./types";

/** One signal as reported by the UIA helper (`value` is `null` when unknown). */
export type HelperSignal = { value: boolean | null; available: boolean; source: string };

/** A snapshot line emitted by the helper's `serve` mode (see `native/`). */
export type HelperSnapshot = {
	teamsRunning: boolean;
	inMeeting: boolean;
	window: { pid: number; name: string } | null;
	signals: {
		mute: HelperSignal;
		camera: HelperSignal;
		hand: HelperSignal;
		sharing: HelperSignal;
	};
};

/** The snapshot used when the helper is not running. */
export const HELPER_DISCONNECTED: TeamsSnapshot = {
	connected: false,
	state: {},
	permissions: {},
	availability: {},
};

/** Whether a signal carries a value the UI can trust: the helper marked it available and it is not
 * null. A signal that is available but null (value unknown) must render "unknown" rather than a fake
 * off state, so both the mapped state value and the availability map derive from this one predicate. */
function isKnown(sig: HelperSignal): boolean {
	return sig.available && sig.value !== null;
}

/** A signal's value, or `undefined` when the helper cannot read it (so it renders "unknown"). */
function known(sig: HelperSignal): boolean | undefined {
	return isKnown(sig) ? (sig.value ?? undefined) : undefined;
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
	};

	// A key is actionable only in a meeting; mute/camera/hand also require that the helper can read
	// the control's state label, so an unreadable label greys and disables the key. Leave/react are
	// control-only (no readable state) but available in a meeting.
	const permissions: Partial<MeetingPermissions> = {
		canToggleMute: inMeeting && s.mute.available,
		canToggleVideo: inMeeting && s.camera.available,
		canToggleHand: inMeeting && s.hand.available,
		canLeave: inMeeting,
		canReact: inMeeting,
	};

	const availability: Partial<Record<keyof MeetingState, boolean>> = {
		isInMeeting: true,
		isMuted: isKnown(s.mute),
		isVideoOn: isKnown(s.camera),
		isHandRaised: isKnown(s.hand),
		isSharing: isKnown(s.sharing),
	};

	// The helper tags a control whose Name it could not interpret as `uia-label?:<name>`. Surface
	// those so a Teams wording change or unsupported locale is diagnosable instead of silently
	// greying the key out.
	const labelIssues: string[] = [];
	for (const [control, signal] of Object.entries(s)) {
		if (signal.source.startsWith("uia-label?:")) {
			labelIssues.push(`${control} ("${signal.source.slice("uia-label?:".length)}")`);
		}
	}

	return {
		connected: h.teamsRunning,
		state,
		permissions,
		availability,
		...(labelIssues.length > 0 ? { labelIssues } : {}),
	};
}
