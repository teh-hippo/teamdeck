import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { MeetingKeyAction } from "./key-action";
import { isActionable } from "./toggle";

@action({ UUID: "io.github.teh-hippo.teamdeck.leave" })
export class Leave extends MeetingKeyAction {
	constructor() {
		super({
			permission: "canLeave",
			command: () => teams.leave(),
			imageFor: (s) => (isActionable(s, "canLeave") ? "imgs/actions/leave/enabled" : "imgs/actions/leave/disabled"),
		});
	}
}
