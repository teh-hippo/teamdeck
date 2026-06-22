import type { MeetingState, TeamsSnapshot } from "../teams/types";

export type StatusImages = { on: string; off: string; unavailable: string };

export type StatusSpec = {
	stateField: keyof MeetingState;
	requiresMeeting: boolean;
	images: StatusImages;
};

export function selectStatusImage(spec: StatusSpec, snapshot: TeamsSnapshot): string {
	if (!snapshot.connected) {
		return spec.images.unavailable;
	}
	if (spec.requiresMeeting && !Boolean(snapshot.state.isInMeeting)) {
		return spec.images.unavailable;
	}
	// Unknown (e.g. recording/unread when read via UIA) must never render a fake on/off state.
	if (snapshot.availability && snapshot.availability[spec.stateField] === false) {
		return spec.images.unavailable;
	}
	return Boolean(snapshot.state[spec.stateField]) ? spec.images.on : spec.images.off;
}

export const RECORDING: StatusSpec = {
	stateField: "isRecordingOn",
	requiresMeeting: true,
	images: {
		on: "imgs/actions/recording/on",
		off: "imgs/actions/recording/off",
		unavailable: "imgs/actions/recording/unavailable",
	},
};

export const SHARING: StatusSpec = {
	stateField: "isSharing",
	requiresMeeting: true,
	images: {
		on: "imgs/actions/sharing/on",
		off: "imgs/actions/sharing/off",
		unavailable: "imgs/actions/sharing/unavailable",
	},
};

export const UNREAD: StatusSpec = {
	stateField: "hasUnreadMessages",
	requiresMeeting: true,
	images: {
		on: "imgs/actions/unread/on",
		off: "imgs/actions/unread/off",
		unavailable: "imgs/actions/unread/unavailable",
	},
};

export const IN_MEETING: StatusSpec = {
	stateField: "isInMeeting",
	requiresMeeting: false,
	images: {
		on: "imgs/actions/inmeeting/on",
		off: "imgs/actions/inmeeting/off",
		unavailable: "imgs/actions/inmeeting/unavailable",
	},
};
