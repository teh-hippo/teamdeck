import type { Presence, TeamsSnapshot } from "../teams/types";

/** Availability tile images. Plain literals (not templates) so check-icons.mjs verifies them; only the default is in the manifest, the rest are setImage-only. */
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

const PRESENCE_IMAGE: Record<Presence, string> = {
	available: IMAGES.available,
	busy: IMAGES.busy,
	doNotDisturb: IMAGES.doNotDisturb,
	beRightBack: IMAGES.beRightBack,
	away: IMAGES.away,
	offline: IMAGES.offline,
	unknown: IMAGES.unknown,
};

/** Selects the Availability tile image by precedence: opt-in off → "opt-in required"; not connected → unknown; DND → DND (wins even in a meeting, matching Teams); in a meeting → "in a meeting"; else the known presence, or unknown. */
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
