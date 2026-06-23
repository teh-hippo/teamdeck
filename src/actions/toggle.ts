import type { MeetingPermissions, MeetingState, ReactionType, TeamsSnapshot } from "../teams/types";

/** Key images for a toggle, by logical state. */
export type ToggleImages = { whenTrue: string; whenFalse: string; disabled: string };

/** The side-effect-free visual specification of a live-state Teams toggle. */
export type ToggleSpec = {
	permission: keyof MeetingPermissions;
	stateField: keyof MeetingState;
	images: ToggleImages;
};

/**
 * Whether a key gated by the given permission can act, from a snapshot. Kept here so this module
 * stays dependency-free and node-testable; it is the single source of truth for actionability.
 */
export function isActionable(snapshot: TeamsSnapshot, permission: keyof MeetingPermissions): boolean {
	return snapshot.connected && Boolean(snapshot.state.isInMeeting) && Boolean(snapshot.permissions[permission]);
}

/** Selects the key image for a toggle given the current snapshot. */
export function selectImage(spec: ToggleSpec, snapshot: TeamsSnapshot): string {
	if (!isActionable(snapshot, spec.permission)) {
		return spec.images.disabled;
	}
	// Never render a definite on/off when the state is unknown (e.g. hand state, which is only
	// readable behind the React flyout). Show the neutral/disabled image rather than a fake "off".
	if (snapshot.availability && snapshot.availability[spec.stateField] === false) {
		return spec.images.disabled;
	}
	return snapshot.state[spec.stateField] ? spec.images.whenTrue : spec.images.whenFalse;
}

/** Mute: muted (isMuted) shows the red image, live shows green. */
export const MUTE: ToggleSpec = {
	permission: "canToggleMute",
	stateField: "isMuted",
	images: {
		whenTrue: "imgs/actions/mute/off",
		whenFalse: "imgs/actions/mute/on",
		disabled: "imgs/actions/mute/disabled",
	},
};

/** Camera: on (isVideoOn) shows green, off shows red. */
export const CAMERA: ToggleSpec = {
	permission: "canToggleVideo",
	stateField: "isVideoOn",
	images: {
		whenTrue: "imgs/actions/camera/on",
		whenFalse: "imgs/actions/camera/off",
		disabled: "imgs/actions/camera/disabled",
	},
};

/** Raise Hand: raised (isHandRaised) shows the raised image, lowered shows neutral. */
export const HAND: ToggleSpec = {
	permission: "canToggleHand",
	stateField: "isHandRaised",
	images: {
		whenTrue: "imgs/actions/hand/raised",
		whenFalse: "imgs/actions/hand/lowered",
		disabled: "imgs/actions/hand/disabled",
	},
};

/** The five Teams reactions: action key → wire type (verified live) and icon name. */
export const REACTIONS = {
	applause: { type: "applause", image: "applause" },
	laugh: { type: "laugh", image: "laugh" },
	like: { type: "like", image: "like" },
	love: { type: "love", image: "love" },
	surprised: { type: "wow", image: "wow" },
} as const satisfies Record<string, { type: ReactionType; image: string }>;
