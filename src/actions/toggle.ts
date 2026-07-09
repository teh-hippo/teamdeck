import type { MeetingPermissions, MeetingState, ReactionType, TeamsSnapshot } from "../teams/types";

type ToggleImages = { whenTrue: string; whenFalse: string; disabled: string };

export type ToggleSpec = {
	permission: keyof MeetingPermissions;
	stateField: keyof MeetingState;
	images: ToggleImages;
};

/** Whether a permission-gated key can act; the single source of truth for actionability (dependency-free, node-testable). */
export function isActionable(snapshot: TeamsSnapshot, permission: keyof MeetingPermissions): boolean {
	return snapshot.connected && Boolean(snapshot.state.isInMeeting) && Boolean(snapshot.permissions[permission]);
}

export function selectImage(spec: ToggleSpec, snapshot: TeamsSnapshot): string {
	if (!isActionable(snapshot, spec.permission)) {
		return spec.images.disabled;
	}
	// Never render a definite on/off when state is unknown (a mute/camera/hand label the helper could not read): show the disabled image, not a fake "off".
	if (snapshot.availability && snapshot.availability[spec.stateField] === false) {
		return spec.images.disabled;
	}
	return snapshot.state[spec.stateField] ? spec.images.whenTrue : spec.images.whenFalse;
}

/** Mute is inverted: muted (isMuted) shows the "off"/red image. */
export const MUTE: ToggleSpec = {
	permission: "canToggleMute",
	stateField: "isMuted",
	images: {
		whenTrue: "imgs/actions/mute/off",
		whenFalse: "imgs/actions/mute/on",
		disabled: "imgs/actions/mute/disabled",
	},
};

export const CAMERA: ToggleSpec = {
	permission: "canToggleVideo",
	stateField: "isVideoOn",
	images: {
		whenTrue: "imgs/actions/camera/on",
		whenFalse: "imgs/actions/camera/off",
		disabled: "imgs/actions/camera/disabled",
	},
};

export const HAND: ToggleSpec = {
	permission: "canToggleHand",
	stateField: "isHandRaised",
	images: {
		whenTrue: "imgs/actions/hand/raised",
		whenFalse: "imgs/actions/hand/lowered",
		disabled: "imgs/actions/hand/disabled",
	},
};

/** The five Teams reactions → wire type + icon name. `disabled` is a plain literal (not `${...}`) so check-icons.mjs can verify these setImage-only tiles, which never appear in the manifest. */
export const REACTIONS = {
	applause: { type: "applause", image: "applause", disabled: "imgs/actions/react/applause-disabled" },
	laugh: { type: "laugh", image: "laugh", disabled: "imgs/actions/react/laugh-disabled" },
	like: { type: "like", image: "like", disabled: "imgs/actions/react/like-disabled" },
	love: { type: "love", image: "love", disabled: "imgs/actions/react/love-disabled" },
	surprised: { type: "wow", image: "wow", disabled: "imgs/actions/react/wow-disabled" },
} as const satisfies Record<string, { type: ReactionType; image: string; disabled: string }>;

/** A reaction's key image: colour when actionable, else its own greyed tile (distinct per reaction, never a shared disabled icon). */
export function selectReactionImage(spec: { image: string; disabled: string }, snapshot: TeamsSnapshot): string {
	return isActionable(snapshot, "canReact") ? `imgs/actions/react/${spec.image}` : spec.disabled;
}
