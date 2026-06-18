import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { BLUR } from "./toggle";
import { ToggleAction } from "./toggle-action";

/**
 * Toggles Microsoft Teams background blur. Teams does not report blur changes, so the key is
 * updated optimistically; a later meeting snapshot reconciles the real value.
 */
@action({ UUID: "io.github.teh-hippo.teamdeck.blur" })
export class Blur extends ToggleAction {
	constructor() {
		super({ ...BLUR, command: () => teams.toggleBlur() });
	}
}
