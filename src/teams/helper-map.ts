import type { MeetingPermissions, MeetingState, Presence, PresenceInfo, TeamsSnapshot } from "./types";

export const HELPER_SCHEMA = 2;

/** One signal as reported by the UIA helper (`value` is `null` when unknown). */
export type HelperSignal = { value: boolean | null; available: boolean; source: string };

/** The presence field as emitted by the helper (absent from an older helper binary). */
export type HelperPresence = { value: string; known: boolean };

/** A snapshot line emitted by the helper's `serve` mode (see `native/`). */
export type HelperSnapshot = {
	type: "snapshot";
	schema: number;
	ts: number;
	teamsRunning: boolean;
	inMeeting: boolean;
	signals: {
		mute: HelperSignal;
		camera: HelperSignal;
		hand: HelperSignal;
		sharing: HelperSignal;
	};
	controls: {
		leave: boolean;
		react: boolean;
	};
	presence?: HelperPresence;
};

/** The presence values the plugin understands; any other token renders "unknown". */
const KNOWN_PRESENCES = new Set<Presence>([
	"available",
	"busy",
	"doNotDisturb",
	"beRightBack",
	"away",
	"offline",
	"unknown",
]);

export const HELPER_DISCONNECTED: TeamsSnapshot = {
	connected: false,
	state: {},
	permissions: {},
	availability: {},
	presence: { value: "unknown", known: false },
};

/** Whether a signal carries a trustworthy value: available and non-null. An available-but-null signal renders "unknown", so state and availability both derive from this one predicate. */
function isKnown(sig: HelperSignal): boolean {
	return sig.available && sig.value !== null;
}

/** A signal's value, or `undefined` when the helper cannot read it (so it renders "unknown"). */
function known(sig: HelperSignal): boolean | undefined {
	return isKnown(sig) ? (sig.value ?? undefined) : undefined;
}

/** Maps the helper's presence field defensively: an absent (older helper) or unrecognised token becomes "unknown" rather than throwing, which would discard the whole snapshot (mute/camera too). */
function mapPresence(p: HelperPresence | undefined): PresenceInfo {
	if (!p || typeof p.value !== "string") {
		return { value: "unknown", known: false };
	}
	const value = KNOWN_PRESENCES.has(p.value as Presence) ? (p.value as Presence) : "unknown";
	return {
		value,
		known: p.known === true && value !== "unknown",
	};
}

/** Maps a helper snapshot onto the plugin's `TeamsSnapshot`. The UIA helper has no permissions/state API, so permissions are synthesised from what it can observe/actuate, and an availability map flags fields it can't read (so keys render "unknown", not a fake on/off). `value: true` means muted / camera-on / hand-raised / sharing. */
export function mapHelperSnapshot(h: HelperSnapshot): TeamsSnapshot {
	if (h.schema !== HELPER_SCHEMA || h.type !== "snapshot" || !Number.isFinite(h.ts)) {
		throw new Error(`unsupported helper snapshot schema ${String(h.schema)}`);
	}
	const s = h.signals;
	const inMeeting = h.inMeeting;

	const state: Partial<MeetingState> = {
		isInMeeting: inMeeting,
		isMuted: known(s.mute),
		isVideoOn: known(s.camera),
		isHandRaised: known(s.hand),
		isSharing: known(s.sharing),
	};

	// A key is actionable only in a meeting; mute/camera/hand also need a readable state label (an unreadable one greys and disables the key), while leave/react are control-only but available in a meeting.
	const permissions: Partial<MeetingPermissions> = {
		canToggleMute: inMeeting && s.mute.available,
		canToggleVideo: inMeeting && s.camera.available,
		canToggleHand: inMeeting && s.hand.available,
		canLeave: inMeeting && h.controls.leave,
		canReact: inMeeting && h.controls.react,
	};

	const availability: Partial<Record<keyof MeetingState, boolean>> = {
		isInMeeting: true,
		isMuted: isKnown(s.mute),
		isVideoOn: isKnown(s.camera),
		isHandRaised: isKnown(s.hand),
		isSharing: isKnown(s.sharing),
	};

	// Surface controls whose UIA state cannot be resolved safely.
	const compatibilityIssues: string[] = [];
	for (const [control, signal] of Object.entries(s)) {
		if (signal.source.startsWith("uia-state-unresolved")) {
			compatibilityIssues.push(`${control} state unavailable (${signal.source})`);
		}
	}

	return {
		connected: h.teamsRunning,
		state,
		permissions,
		availability,
		presence: mapPresence(h.presence),
		...(compatibilityIssues.length > 0 ? { compatibilityIssues } : {}),
	};
}
