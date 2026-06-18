import type { MeetingPermissions, TeamsSnapshot } from "../teams/types";
import { MeetingKeyAction } from "./meeting-key-action";
import { isActionable } from "./toggle";

/** Configuration for a stateless gated action (e.g. Leave, reactions). */
export type FireConfig = {
	permission: keyof MeetingPermissions;
	command: () => void;
	images: { enabled: string; disabled: string };
};

/**
 * A stateless gated action: the key shows the enabled image when the permission allows it and
 * the disabled image otherwise, and fires its command on press.
 */
export abstract class FireAction extends MeetingKeyAction {
	readonly #config: FireConfig;

	constructor(config: FireConfig) {
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
		const { images } = this.#config;
		return isActionable(snapshot, this.#config.permission) ? images.enabled : images.disabled;
	}
}
