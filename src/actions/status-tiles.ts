import { action } from "@elgato/streamdeck";
import { ReadOnlyKeyAction } from "./key-action";
import { IN_MEETING, SHARING, selectStatusImage } from "./status";

@action({ UUID: "io.github.teh-hippo.teamdeck.sharing" })
export class Sharing extends ReadOnlyKeyAction {
	constructor() {
		super((snapshot) => selectStatusImage(SHARING, snapshot));
	}
}

@action({ UUID: "io.github.teh-hippo.teamdeck.inmeeting" })
export class InMeeting extends ReadOnlyKeyAction {
	constructor() {
		super((snapshot) => selectStatusImage(IN_MEETING, snapshot));
	}
}
