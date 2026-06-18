import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { type KeyConfig, MeetingKeyAction } from "./key-action";
import { isActionable, REACTIONS } from "./toggle";

/** Builds a reaction's KeyConfig: gated on canReact, showing its icon when actionable. */
function reaction(spec: (typeof REACTIONS)[keyof typeof REACTIONS]): KeyConfig {
	const enabled = `imgs/actions/react/${spec.image}`;
	return {
		permission: "canReact",
		command: () => teams.react(spec.type),
		imageFor: (s) => (isActionable(s, "canReact") ? enabled : "imgs/actions/react/disabled"),
	};
}

/** Sends an applause reaction. */
@action({ UUID: "io.github.teh-hippo.teamdeck.applause" })
export class Applause extends MeetingKeyAction {
	constructor() {
		super(reaction(REACTIONS.applause));
	}
}

/** Sends a laugh reaction. */
@action({ UUID: "io.github.teh-hippo.teamdeck.laugh" })
export class Laugh extends MeetingKeyAction {
	constructor() {
		super(reaction(REACTIONS.laugh));
	}
}

/** Sends a like reaction. */
@action({ UUID: "io.github.teh-hippo.teamdeck.like" })
export class Like extends MeetingKeyAction {
	constructor() {
		super(reaction(REACTIONS.like));
	}
}

/** Sends a love reaction. */
@action({ UUID: "io.github.teh-hippo.teamdeck.love" })
export class Love extends MeetingKeyAction {
	constructor() {
		super(reaction(REACTIONS.love));
	}
}

/** Sends a "Surprised" reaction (the API's `wow`). */
@action({ UUID: "io.github.teh-hippo.teamdeck.surprised" })
export class Surprised extends MeetingKeyAction {
	constructor() {
		super(reaction(REACTIONS.surprised));
	}
}
