import { action } from "@elgato/streamdeck";
import { ReadOnlyKeyAction } from "./key-action";
import { selectPresenceImage } from "./presence";

/** Read-only Teams availability tile. Opt-in: presence is read from the local Teams log only after you enable it in the property inspector. */
@action({ UUID: "io.github.teh-hippo.teamdeck.availability" })
export class Availability extends ReadOnlyKeyAction {
	constructor() {
		super(selectPresenceImage);
	}
}
