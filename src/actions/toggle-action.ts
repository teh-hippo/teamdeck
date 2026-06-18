import { type DialAction, type KeyAction, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import { actionable } from "../teams/protocol";
import type { MeetingPermissions, MeetingState, TeamsSnapshot } from "../teams/types";

/** Declarative configuration for a two-state, live-state Teams toggle key. */
export type ToggleConfig = {
	/** Permission that gates the key and the command. */
	permission: keyof MeetingPermissions;
	/** Meeting state field that drives the on/off image. */
	stateField: keyof MeetingState;
	/** Sends the toggle command to Teams. */
	command: () => void;
	/** Key images by logical state. */
	images: { whenTrue: string; whenFalse: string; disabled: string };
};

/**
 * Base class for a Teams toggle action. Subscribes to the shared client, mirrors live meeting
 * state onto every visible key, greys out when not actionable, and toggles (or recovers the
 * connection / re-triggers pairing) on press. Concrete actions supply a {@link ToggleConfig}
 * and the `@action` UUID.
 */
export abstract class ToggleAction extends SingletonAction {
	readonly #config: ToggleConfig;

	constructor(config: ToggleConfig) {
		super();
		this.#config = config;
		// A single subscription drives every visible instance of this action.
		teams.subscribe((snapshot) => {
			for (const visible of this.actions) {
				this.#render(visible, snapshot);
			}
		});
	}

	override onWillAppear(ev: WillAppearEvent): void {
		this.#render(ev.action, teams.snapshot);
	}

	override onKeyDown(): void {
		if (teams.isActionable(this.#config.permission)) {
			this.#config.command();
		} else {
			// Not actionable (stale socket, or a missed pairing prompt): poke a reconnect, which
			// re-triggers pairing while in a meeting.
			teams.reconnect();
		}
	}

	#render(target: DialAction | KeyAction, snapshot: TeamsSnapshot): void {
		if (!target.isKey()) {
			return;
		}
		const { images } = this.#config;
		// Render purely via setImage: setState alone cannot clear a previous setImage override.
		if (!actionable(snapshot, this.#config.permission)) {
			void target.setImage(images.disabled);
			return;
		}
		void target.setImage(snapshot.state[this.#config.stateField] ? images.whenTrue : images.whenFalse);
	}
}
