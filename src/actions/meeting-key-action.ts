import {
	type DialAction,
	type KeyAction,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { teams } from "../teams/client";
import type { MeetingPermissions, TeamsSnapshot } from "../teams/types";

/**
 * Shared base for Teams meeting keys. Subscribes to the client, renders every visible instance
 * via setImage (memoised), greys out when not actionable, and on press runs the command when
 * actionable or recovers the connection / re-triggers pairing otherwise. Subclasses provide the
 * gating permission, the command, and the image for a snapshot.
 */
export abstract class MeetingKeyAction extends SingletonAction {
	readonly #lastImage = new Map<string, string>();

	constructor() {
		super();
		// Re-render every visible instance whenever Teams state changes. The initial render is
		// handled by onWillAppear; no instances are visible yet at construction.
		teams.subscribe((snapshot) => {
			for (const visible of this.actions) {
				this.#render(visible, snapshot);
			}
		});
	}

	/** The permission that gates this key's command and actionability. */
	protected abstract permission(): keyof MeetingPermissions;

	/** Performs the Teams command for this key. */
	protected abstract command(): void;

	/** Selects the key image for the given snapshot. */
	protected abstract imageFor(snapshot: TeamsSnapshot): string;

	override onWillAppear(ev: WillAppearEvent): void {
		this.#render(ev.action, teams.snapshot);
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.#lastImage.delete(ev.action.id);
	}

	override onKeyDown(): void {
		if (teams.isActionable(this.permission())) {
			this.command();
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
		const image = this.imageFor(snapshot);
		if (this.#lastImage.get(target.id) === image) {
			return;
		}
		this.#lastImage.set(target.id, image);
		void target.setImage(image);
	}
}
