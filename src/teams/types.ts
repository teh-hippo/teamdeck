/** Live meeting state reported by Teams (`meetingUpdate.meetingState`). */
export type MeetingState = {
	isMuted: boolean;
	isVideoOn: boolean;
	isHandRaised: boolean;
	isInMeeting: boolean;
	isRecordingOn: boolean;
	isBackgroundBlurred: boolean;
	isSharing: boolean;
	hasUnreadMessages: boolean;
};

/** Capabilities reported by Teams (`meetingUpdate.meetingPermissions`). */
export type MeetingPermissions = {
	canToggleMute: boolean;
	canToggleVideo: boolean;
	canToggleHand: boolean;
	canToggleBlur: boolean;
	canLeave: boolean;
	canReact: boolean;
};

/** Reaction types accepted by the `send-reaction` command. */
export type ReactionType = "like" | "love" | "applause" | "laugh" | "wow";

/** A subscriber to snapshot updates. */
export type Listener = (snapshot: TeamsSnapshot) => void;

/** Snapshot of the Teams connection broadcast to subscribers. */
export type TeamsSnapshot = {
	connected: boolean;
	state: Partial<MeetingState>;
	permissions: Partial<MeetingPermissions>;
	/**
	 * Per-field knowledge map. When a field is explicitly `false`, its value is unknown and keys
	 * must render "unavailable" rather than a (possibly wrong) on/off state. An absent entry means
	 * the present field value is known.
	 */
	availability?: Partial<Record<keyof MeetingState, boolean>>;
};
