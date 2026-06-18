import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { HAND } from "./toggle";
import { ToggleAction } from "./toggle-action";

/**
 * Raises or lowers your hand in Microsoft Teams and mirrors live state: highlighted when
 * raised, neutral when lowered, greyed when not in a meeting.
 */
@action({ UUID: "io.github.teh-hippo.teamdeck.hand" })
export class Hand extends ToggleAction {
	constructor() {
		super({ ...HAND, command: () => teams.toggleHand() });
	}
}

