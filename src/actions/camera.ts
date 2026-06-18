import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { ToggleAction } from "./toggle-action";

/**
 * Toggles the Microsoft Teams camera and mirrors live state: green when the camera is on, red
 * when off, greyed when not in a meeting.
 */
@action({ UUID: "io.github.teh-hippo.teamdeck.camera" })
export class Camera extends ToggleAction {
	constructor() {
		super({
			permission: "canToggleVideo",
			stateField: "isVideoOn",
			command: () => teams.toggleVideo(),
			images: {
				whenTrue: "imgs/actions/camera/on",
				whenFalse: "imgs/actions/camera/off",
				disabled: "imgs/actions/camera/disabled",
			},
		});
	}
}
