import { action } from "@elgato/streamdeck";

import { IN_MEETING, RECORDING, SHARING, UNREAD } from "./status";
import { StatusAction } from "./key-action";

/** Mirrors whether the current Microsoft Teams meeting is recording. */
@action({ UUID: "io.github.teh-hippo.teamdeck.recording" })
export class Recording extends StatusAction {
	constructor() {
		super(RECORDING);
	}
}

/** Mirrors whether screen sharing is active in the current Microsoft Teams meeting. */
@action({ UUID: "io.github.teh-hippo.teamdeck.sharing" })
export class Sharing extends StatusAction {
	constructor() {
		super(SHARING);
	}
}

/** Mirrors whether Microsoft Teams reports unread meeting messages. */
@action({ UUID: "io.github.teh-hippo.teamdeck.unread" })
export class Unread extends StatusAction {
	constructor() {
		super(UNREAD);
	}
}

/** Mirrors whether Microsoft Teams reports an active meeting. */
@action({ UUID: "io.github.teh-hippo.teamdeck.inmeeting" })
export class InMeeting extends StatusAction {
	constructor() {
		super(IN_MEETING);
	}
}
