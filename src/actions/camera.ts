import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { CAMERA } from "./toggle";
import { ToggleAction } from "./toggle-action";

/**
 * Toggles the Microsoft Teams camera and mirrors live state: green when the camera is on, red
 * when off, greyed when not in a meeting.
 */
@action({ UUID: "io.github.teh-hippo.teamdeck.camera" })
export class Camera extends ToggleAction {
	constructor() {
		super({ ...CAMERA, command: () => teams.toggleVideo() });
	}
}

