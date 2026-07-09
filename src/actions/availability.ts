import { action } from "@elgato/streamdeck";
import { PresenceKeyAction } from "./key-action";
import { selectPresenceImage } from "./presence";

/** Read-only Teams availability tile. Opt-in: presence is read from the local Teams log only after you enable it in the property inspector. */
@action({ UUID: "io.github.teh-hippo.teamdeck.availability" })
export class Availability extends PresenceKeyAction {
	constructor() {
		super(selectPresenceImage);
	}
}
