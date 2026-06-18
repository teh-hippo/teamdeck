import {
	type DialAction,
	type KeyAction,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { teams } from "../teams/client";
import type { TeamsSnapshot } from "../teams/types";

/**
 * Shared base for Teams keys that render live state. Subscribes to the client, renders every
 * visible instance via setImage (memoised), and lets subclasses provide the image for a snapshot.
 */
export abstract class RenderingKeyAction extends SingletonAction {
	readonly #lastImage = new Map<string, string>();

	constructor() {
		super();
		// Re-render every visible instance whenever Teams state changes. The initial render is
		// handled by onWillAppear. NB: subscribe replays a snapshot synchronously here, before a
		// subclass constructor has set its config; this is safe only because this.actions is empty
		// at construction (so imageFor is never called). Keep this callback dependent only on
		// this.actions, never on subclass fields.
		teams.subscribe((snapshot) => {
			for (const visible of this.actions) {
				this.#render(visible, snapshot);
			}
		});
	}

	/** Selects the key image for the given snapshot. */
	protected abstract imageFor(snapshot: TeamsSnapshot): string;

	override onWillAppear(ev: WillAppearEvent): void {
		this.#render(ev.action, teams.snapshot);
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.#lastImage.delete(ev.action.id);
	}

	#render(target: DialAction | KeyAction, snapshot: TeamsSnapshot): void {
		if (!target.isKey()) {
			return;
		}
		// Render purely via setImage: setState alone cannot clear a previous setImage override.
		const image = this.imageFor(snapshot);
		if (this.#lastImage.get(target.id) === image) {
			return;
		}
		this.#lastImage.set(target.id, image);
		void target.setImage(image);
	}
}
