import { action } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import type { ReactionType } from "../teams/types";
import { type FireConfig, FireAction } from "./fire-action";

/** Builds a reaction's FireConfig: gated on canReact, with the reaction's icon. */
function reaction(type: ReactionType, image: string): FireConfig {
	return {
		permission: "canReact",
		command: () => teams.react(type),
		images: { enabled: `imgs/actions/react/${image}`, disabled: "imgs/actions/react/disabled" },
	};
}

/** Sends an applause reaction. */
@action({ UUID: "io.github.teh-hippo.teamdeck.applause" })
export class Applause extends FireAction {
	constructor() {
		super(reaction("applause", "applause"));
	}
}

/** Sends a laugh reaction. */
@action({ UUID: "io.github.teh-hippo.teamdeck.laugh" })
export class Laugh extends FireAction {
	constructor() {
		super(reaction("laugh", "laugh"));
	}
}

/** Sends a like reaction. */
@action({ UUID: "io.github.teh-hippo.teamdeck.like" })
export class Like extends FireAction {
	constructor() {
		super(reaction("like", "like"));
	}
}

/** Sends a love reaction. */
@action({ UUID: "io.github.teh-hippo.teamdeck.love" })
export class Love extends FireAction {
	constructor() {
		super(reaction("love", "love"));
	}
}

/** Sends a "Surprised" reaction (the API's `wow`). */
@action({ UUID: "io.github.teh-hippo.teamdeck.surprised" })
export class Surprised extends FireAction {
	constructor() {
		super(reaction("wow", "wow"));
	}
}
