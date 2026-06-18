import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { FireAction } from "./fire-action";

/**
 * Leaves the current Microsoft Teams meeting. Enabled only while a meeting allows leaving.
 */
@action({ UUID: "io.github.teh-hippo.teamdeck.leave" })
export class Leave extends FireAction {
	constructor() {
		super({
			permission: "canLeave",
			command: () => teams.leave(),
			images: { enabled: "imgs/actions/leave/enabled", disabled: "imgs/actions/leave/disabled" },
		});
	}
}
