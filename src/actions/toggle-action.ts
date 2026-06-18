import type { MeetingPermissions, TeamsSnapshot } from "../teams/types";
import { MeetingKeyAction } from "./meeting-key-action";
import { selectImage, type ToggleConfig } from "./toggle";

/**
 * A live-state two-image toggle (e.g. Mute, Camera, Raise Hand): the key shows the whenTrue /
 * whenFalse image by a meeting state field, and greys out when not actionable.
 */
export abstract class ToggleAction extends MeetingKeyAction {
	readonly #config: ToggleConfig;

	constructor(config: ToggleConfig) {
		super();
		this.#config = config;
	}

	protected override permission(): keyof MeetingPermissions {
		return this.#config.permission;
	}

	protected override command(): void {
		this.#config.command();
	}

	protected override imageFor(snapshot: TeamsSnapshot): string {
		return selectImage(this.#config, snapshot);
	}
}


