export type MeetingState = {
	isMuted: boolean;
	isVideoOn: boolean;
	isHandRaised: boolean;
	isInMeeting: boolean;
	isSharing: boolean;
};

/** Per-action capabilities, synthesised from what the helper can observe/actuate. */
export type MeetingPermissions = {
	canToggleMute: boolean;
	canToggleVideo: boolean;
	canToggleHand: boolean;
	canLeave: boolean;
	canReact: boolean;
};

export type ReactionType = "like" | "love" | "applause" | "laugh" | "wow";

/** Coarse Teams availability (mirrors the helper's Presence enum); "unknown" covers not-read-yet, opt-in-off and Teams-not-running. */
export type Presence = "available" | "busy" | "doNotDisturb" | "beRightBack" | "away" | "offline" | "unknown";

/** Snapshot presence field. `known` is false when the value must render "unavailable"; `source` is a fixed helper token (teams-log/disabled/none), never raw log text. */
export type PresenceInfo = { value: Presence; known: boolean; source: string };

export type Listener = (snapshot: TeamsSnapshot) => void;

export type TeamsSnapshot = {
	connected: boolean;
	state: Partial<MeetingState>;
	permissions: Partial<MeetingPermissions>;
	/** Per-field knowledge map: an explicit `false` means the value is unknown (render "unavailable", not a fake on/off); an absent entry means known. */
	availability?: Partial<Record<keyof MeetingState, boolean>>;
	/** Controls whose UIA label the helper found but could not interpret (Teams reworded it, or an unsupported locale), so their state renders unknown. Absent when all labels were understood. */
	labelIssues?: string[];
	/** Coarse Teams availability, from the opt-in Teams-log reader. Absent from an older helper. */
	presence?: PresenceInfo;
	/** Presence opt-in, injected by the client from the persisted setting (not the helper), so the tile paints from the setting rather than the helper's lagging `source` and never flickers at startup. */
	logReadingAllowed?: boolean;
};
