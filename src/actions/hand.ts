import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { ToggleAction } from "./toggle-action";

/**
 * Raises or lowers your hand in Microsoft Teams and mirrors live state: highlighted when
 * raised, neutral when lowered, greyed when not in a meeting.
 */
@action({ UUID: "io.github.teh-hippo.teamdeck.hand" })
export class Hand extends ToggleAction {
	constructor() {
		super({
			permission: "canToggleHand",
			stateField: "isHandRaised",
			command: () => teams.toggleHand(),
			images: {
				whenTrue: "imgs/actions/hand/raised",
				whenFalse: "imgs/actions/hand/lowered",
				disabled: "imgs/actions/hand/disabled",
			},
		});
	}
}
