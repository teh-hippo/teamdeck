import {
	type DialAction,
	type KeyAction,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { teams } from "../teams/client";
import type { MeetingPermissions, TeamsSnapshot } from "../teams/types";
import { selectStatusImage, type StatusSpec } from "./status";

/** Selects the key image to render for a given Teams snapshot. */
export type ImageFor = (snapshot: TeamsSnapshot) => string;

/**
 * Shared base for Teams keys that render live state. Subscribes to the client and re-renders
 * every visible instance via setImage (memoised) whenever Teams state changes; subclasses supply
 * the image selector.
 */
export abstract class RenderingKeyAction extends SingletonAction {
	readonly #lastImage = new Map<string, string>();
	readonly #imageFor: ImageFor;

	constructor(imageFor: ImageFor) {
		super();
		this.#imageFor = imageFor;
		// Re-render every visible instance whenever Teams state changes; onWillAppear handles the
		// initial render. subscribe replays a snapshot synchronously here, but this.actions is empty
		// at construction, so imageFor is never called before the subclass finishes constructing.
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

	#render(target: DialAction | KeyAction, snapshot: TeamsSnapshot): void {
		if (!target.isKey()) {
			return;
		}
		// Render purely via setImage: setState alone cannot clear a previous setImage override.
		const image = this.#imageFor(snapshot);
		if (this.#lastImage.get(target.id) === image) {
			return;
		}
		this.#lastImage.set(target.id, image);
		void target.setImage(image);
	}
}

/** A meeting key's gating permission, the command it sends, and its image selector. */
export type KeyConfig = {
	permission: keyof MeetingPermissions;
	command: () => void;
	imageFor: ImageFor;
};

/**
 * Shared base for Teams meeting keys. Renders live state and, on press, runs the command when
 * actionable or otherwise recovers a stuck socket / re-triggers a missed pairing prompt.
 */
export abstract class MeetingKeyAction extends RenderingKeyAction {
	readonly #permission: keyof MeetingPermissions;
	readonly #command: () => void;

	constructor(config: KeyConfig) {
		super(config.imageFor);
		this.#permission = config.permission;
		this.#command = config.command;
	}

	override onKeyDown(): void {
		if (teams.isActionable(this.#permission)) {
			this.#command();
		} else {
			// Not actionable: recover a stuck socket or a missed pairing prompt (no-op if healthy).
			teams.recover();
		}
	}
}

/** Read-only Teams status tile: renders live state and never sends a Teams command. */
export abstract class StatusAction extends RenderingKeyAction {
	constructor(spec: StatusSpec) {
		super((snapshot) => selectStatusImage(spec, snapshot));
	}

	override onKeyDown(): void {
		teams.recover();
	}
}
