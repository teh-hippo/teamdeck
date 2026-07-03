import { action } from "@elgato/streamdeck";
import { PresenceKeyAction } from "./key-action";
import { selectPresenceImage } from "./presence";

/**
 * Mirrors your Microsoft Teams availability (Available / Busy / Do Not Disturb / Be Right Back /
 * Away / Offline, plus "In a meeting"). Read-only and opt-in: presence is read from the local Teams
 * log only after you enable "Allow reading status via Teams logs" in the property inspector.
 */
@action({ UUID: "io.github.teh-hippo.teamdeck.availability" })
export class Availability extends PresenceKeyAction {
	constructor() {
		super(selectPresenceImage);
	}
}
