import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { MeetingKeyAction } from "./key-action";
import { CAMERA, HAND, MUTE, selectImage } from "./toggle";

/**
 * Toggles the Microsoft Teams microphone and mirrors live mute state: green when live (unmuted),
 * red when muted, greyed when not in a meeting.
 */
@action({ UUID: "io.github.teh-hippo.teamdeck.mute" })
export class Mute extends MeetingKeyAction {
	constructor() {
		super({ permission: MUTE.permission, command: () => teams.toggleMute(), imageFor: (s) => selectImage(MUTE, s) });
	}
}

/**
 * Toggles the Microsoft Teams camera and mirrors live state: green when on, red when off, greyed
 * when not in a meeting.
 */
@action({ UUID: "io.github.teh-hippo.teamdeck.camera" })
export class Camera extends MeetingKeyAction {
	constructor() {
		super({
			permission: CAMERA.permission,
			command: () => teams.toggleVideo(),
			imageFor: (s) => selectImage(CAMERA, s),
		});
	}
}

/**
 * Raises or lowers your hand in Microsoft Teams: highlighted when raised, neutral when lowered,
 * greyed when not in a meeting.
 */
@action({ UUID: "io.github.teh-hippo.teamdeck.hand" })
export class Hand extends MeetingKeyAction {
	constructor() {
		super({ permission: HAND.permission, command: () => teams.toggleHand(), imageFor: (s) => selectImage(HAND, s) });
	}
}
