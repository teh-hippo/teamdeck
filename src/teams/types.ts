/** Live meeting state, as mapped from the helper snapshot. */
export type MeetingState = {
	isMuted: boolean;
	isVideoOn: boolean;
	isHandRaised: boolean;
	isInMeeting: boolean;
	isSharing: boolean;
};

/** Per-action capabilities, synthesized from what the helper can observe and actuate. */
export type MeetingPermissions = {
	canToggleMute: boolean;
	canToggleVideo: boolean;
	canToggleHand: boolean;
	canLeave: boolean;
	canReact: boolean;
};

/** Reaction types accepted by the `send-reaction` command. */
export type ReactionType = "like" | "love" | "applause" | "laugh" | "wow";

/** Coarse Teams availability, read from the New Teams log. Mirrors the helper's `Presence` enum.
 * `unknown` covers "not read yet", "opt-in off" and "Teams not running". */
export type Presence = "available" | "busy" | "doNotDisturb" | "beRightBack" | "away" | "offline" | "unknown";

/** The presence field of a snapshot. `known` is false when the value must render "unavailable".
 * `source` is one of the helper's fixed tokens (`teams-log`/`disabled`/`none`) — never raw log text. */
export type PresenceInfo = { value: Presence; known: boolean; source: string };

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
	/**
	 * Controls whose UIA label the helper found but could not interpret (Teams reworded the control,
	 * or the display language is unsupported), so their state renders unknown. Absent when every
	 * present label was understood.
	 */
	labelIssues?: string[];
	/** Coarse Teams availability, from the opt-in Teams-log reader. Absent from an older helper. */
	presence?: PresenceInfo;
	/**
	 * Whether the user has opted in to reading presence from the Teams log. Injected by the client
	 * from the persisted global setting (not the helper), so the tile paints from the setting rather
	 * than the helper's lagging `source` and never flickers "opt-in required" at startup.
	 */
	logReadingAllowed?: boolean;
};
