import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { MUTE } from "./toggle";
import { ToggleAction } from "./toggle-action";

/**
 * Toggles the Microsoft Teams microphone and mirrors live mute state on the key: green when
 * live (unmuted), red when muted, greyed when not in a meeting.
 */
@action({ UUID: "io.github.teh-hippo.teamdeck.mute" })
export class Mute extends ToggleAction {
	constructor() {
		super({ ...MUTE, command: () => teams.toggleMute() });
	}
}


