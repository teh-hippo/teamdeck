import { action } from "@elgato/streamdeck";
import { StatusAction } from "./key-action";
import { IN_MEETING, SHARING } from "./status";

/** Mirrors whether screen sharing is active in the current Microsoft Teams meeting. */
@action({ UUID: "io.github.teh-hippo.teamdeck.sharing" })
export class Sharing extends StatusAction {
	constructor() {
		super(SHARING);
	}
}

/** Mirrors whether Microsoft Teams reports an active meeting. */
@action({ UUID: "io.github.teh-hippo.teamdeck.inmeeting" })
export class InMeeting extends StatusAction {
	constructor() {
		super(IN_MEETING);
	}
}
