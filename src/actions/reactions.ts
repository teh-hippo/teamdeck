import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { type KeyConfig, MeetingKeyAction } from "./key-action";
import { REACTIONS, selectReactionImage } from "./toggle";

/** Builds a reaction's KeyConfig, gated on canReact. */
function reaction(spec: (typeof REACTIONS)[keyof typeof REACTIONS]): KeyConfig {
	return {
		permission: "canReact",
		command: () => teams.react(spec.type),
		imageFor: (s) => selectReactionImage(spec, s),
	};
}

@action({ UUID: "io.github.teh-hippo.teamdeck.applause" })
export class Applause extends MeetingKeyAction {
	constructor() {
		super(reaction(REACTIONS.applause));
	}
}

@action({ UUID: "io.github.teh-hippo.teamdeck.laugh" })
export class Laugh extends MeetingKeyAction {
	constructor() {
		super(reaction(REACTIONS.laugh));
	}
}

@action({ UUID: "io.github.teh-hippo.teamdeck.like" })
export class Like extends MeetingKeyAction {
	constructor() {
		super(reaction(REACTIONS.like));
	}
}

@action({ UUID: "io.github.teh-hippo.teamdeck.love" })
export class Love extends MeetingKeyAction {
	constructor() {
		super(reaction(REACTIONS.love));
	}
}

@action({ UUID: "io.github.teh-hippo.teamdeck.surprised" })
export class Surprised extends MeetingKeyAction {
	constructor() {
		super(reaction(REACTIONS.surprised));
	}
}
