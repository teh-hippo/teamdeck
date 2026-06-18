import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { type FireConfig, FireAction } from "./fire-action";
import { REACTIONS } from "./toggle";

/** Builds a reaction's FireConfig from a REACTIONS entry: gated on canReact, with its icon. */
function reaction(spec: (typeof REACTIONS)[keyof typeof REACTIONS]): FireConfig {
	return {
		permission: "canReact",
		command: () => teams.react(spec.type),
		images: { enabled: `imgs/actions/react/${spec.image}`, disabled: "imgs/actions/react/disabled" },
	};
}

/** Sends an applause reaction. */
@action({ UUID: "io.github.teh-hippo.teamdeck.applause" })
export class Applause extends FireAction {
	constructor() {
		super(reaction(REACTIONS.applause));
	}
}

/** Sends a laugh reaction. */
@action({ UUID: "io.github.teh-hippo.teamdeck.laugh" })
export class Laugh extends FireAction {
	constructor() {
		super(reaction(REACTIONS.laugh));
	}
}

/** Sends a like reaction. */
@action({ UUID: "io.github.teh-hippo.teamdeck.like" })
export class Like extends FireAction {
	constructor() {
		super(reaction(REACTIONS.like));
	}
}

/** Sends a love reaction. */
@action({ UUID: "io.github.teh-hippo.teamdeck.love" })
export class Love extends FireAction {
	constructor() {
		super(reaction(REACTIONS.love));
	}
}

/** Sends a "Surprised" reaction (the API's `wow`). */
@action({ UUID: "io.github.teh-hippo.teamdeck.surprised" })
export class Surprised extends FireAction {
	constructor() {
		super(reaction(REACTIONS.surprised));
	}
}

