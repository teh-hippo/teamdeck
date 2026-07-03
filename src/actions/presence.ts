import type { Presence, TeamsSnapshot } from "../teams/types";

/**
 * The Availability tile's images, one per rendered state. Every value is a plain string literal (not
 * a template) so `tools/check-icons.mjs` verifies each exists on disk — only the default image is in
 * the manifest; the rest are set at runtime via setImage.
 */
const IMAGES = {
	available: "imgs/actions/availability/available",
	busy: "imgs/actions/availability/busy",
	doNotDisturb: "imgs/actions/availability/dnd",
	beRightBack: "imgs/actions/availability/brb",
	away: "imgs/actions/availability/away",
	offline: "imgs/actions/availability/offline",
	inMeeting: "imgs/actions/availability/inmeeting",
	unknown: "imgs/actions/availability/unknown",
	optInRequired: "imgs/actions/availability/optin",
} as const;

/** Maps a coarse presence value to its tile image (the DND and unknown cases are handled earlier). */
const PRESENCE_IMAGE: Record<Presence, string> = {
	available: IMAGES.available,
	busy: IMAGES.busy,
	doNotDisturb: IMAGES.doNotDisturb,
	beRightBack: IMAGES.beRightBack,
	away: IMAGES.away,
	offline: IMAGES.offline,
	unknown: IMAGES.unknown,
};

/**
 * Selects the Availability tile image. Precedence, kept here as the single source of truth so it is
 * dependency-free and node-testable:
 *  1. Opt-in off (from the persisted setting, not the helper) → "opt-in required".
 *  2. Teams not running → unknown (presence can't be read).
 *  3. Do Not Disturb → DND, even in a meeting (matches Teams' own presence precedence).
 *  4. In a meeting (from the helper's real-time detection) → "in a meeting".
 *  5. A known presence → its image; otherwise unknown.
 */
export function selectPresenceImage(snapshot: TeamsSnapshot): string {
	if (snapshot.logReadingAllowed !== true) {
		return IMAGES.optInRequired;
	}
	if (!snapshot.connected) {
		return IMAGES.unknown;
	}
	const presence = snapshot.presence;
	if (presence?.value === "doNotDisturb") {
		return IMAGES.doNotDisturb;
	}
	if (snapshot.state.isInMeeting) {
		return IMAGES.inMeeting;
	}
	if (presence?.known) {
		return PRESENCE_IMAGE[presence.value] ?? IMAGES.unknown;
	}
	return IMAGES.unknown;
}
