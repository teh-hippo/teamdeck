import {
	type DialAction,
	type KeyAction,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { teams } from "../teams/client";
import type { TeamsSnapshot } from "../teams/types";
import { selectImage, type ToggleConfig } from "./toggle";

/**
 * Base class for a Teams toggle action. Subscribes to the shared client, mirrors live meeting
 * state onto every visible key, greys out when not actionable, and toggles (or recovers the
 * connection / re-triggers pairing) on press. Concrete actions supply a {@link ToggleConfig}
 * and the `@action` UUID.
 */
export abstract class ToggleAction extends SingletonAction {
	readonly #config: ToggleConfig;
	readonly #lastImage = new Map<string, string>();

	constructor(config: ToggleConfig) {
		super();
		this.#config = config;
		// Re-render every visible instance whenever Teams state changes. The initial render is
		// handled by onWillAppear; no instances are visible yet at construction.
		teams.subscribe((snapshot) => {
			for (const visible of this.actions) {
				this.#render(visible, snapshot);
			}
		});
	}

	override onWillAppear(ev: WillAppearEvent): void {
		this.#render(ev.action, teams.snapshot);
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.#lastImage.delete(ev.action.id);
	}

	override onKeyDown(): void {
		if (teams.isActionable(this.#config.permission)) {
			this.#config.command();
		} else {
			// Not actionable: recover a stuck socket or a missed pairing prompt (no-op if healthy).
			teams.recover();
		}
	}

	#render(target: DialAction | KeyAction, snapshot: TeamsSnapshot): void {
		if (!target.isKey()) {
			return;
		}
		// Render purely via setImage: setState alone cannot clear a previous setImage override.
		const image = selectImage(this.#config, snapshot);
		if (this.#lastImage.get(target.id) === image) {
			return;
		}
		this.#lastImage.set(target.id, image);
		void target.setImage(image);
	}
}

