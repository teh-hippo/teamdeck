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
	canToggleShareTray: boolean;
	canToggleChat: boolean;
	canStopSharing: boolean;
	canPair: boolean;
};

/** Reaction types accepted by the `send-reaction` command. */
export type ReactionType = "like" | "love" | "applause" | "laugh" | "wow";

/** Snapshot of the Teams connection broadcast to subscribers. */
export type TeamsSnapshot = {
	connected: boolean;
	paired: boolean;
	state: Partial<MeetingState>;
	permissions: Partial<MeetingPermissions>;
};
