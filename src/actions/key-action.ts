import {
	type DialAction,
	type KeyAction,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { teams } from "../teams/client";
import type { MeetingPermissions, TeamsSnapshot } from "../teams/types";
import { type StatusSpec, selectStatusImage } from "./status";
import { isActionable } from "./toggle";

type ImageFor = (snapshot: TeamsSnapshot) => string;

/** Base for Teams keys that render live state: subscribes and re-renders every visible instance via setImage (memoised); subclasses supply the selector. */
abstract class RenderingKeyAction extends SingletonAction {
	readonly #lastImage = new Map<string, string>();
	readonly #imageFor: ImageFor;

	constructor(imageFor: ImageFor) {
		super();
		this.#imageFor = imageFor;
		// Re-render every visible instance on Teams state change (onWillAppear does the initial render); this.actions is empty at construction, so the synchronous replay never calls imageFor early.
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

export type KeyConfig = {
	permission: keyof MeetingPermissions;
	command: () => void;
	imageFor: ImageFor;
};

/** Base for Teams meeting keys: on press, runs the command when actionable, else nudges the helper to recover (no-op when healthy). */
export abstract class MeetingKeyAction extends RenderingKeyAction {
	readonly #permission: keyof MeetingPermissions;
	readonly #command: () => void;

	constructor(config: KeyConfig) {
		super(config.imageFor);
		this.#permission = config.permission;
		this.#command = config.command;
	}

	override onKeyDown(): void {
		if (isActionable(teams.snapshot, this.#permission)) {
			this.#command();
		} else {
			// Not actionable: ask the helper to recover, e.g. respawn if it died (no-op when healthy).
			teams.recover();
		}
	}
}

/** Read-only Teams status tile: renders live state, sends no command. */
export abstract class StatusAction extends RenderingKeyAction {
	constructor(spec: StatusSpec) {
		super((snapshot) => selectStatusImage(spec, snapshot));
	}

	override onKeyDown(): void {
		teams.recover();
	}
}

/** Read-only tile for a multi-state selector (e.g. presence) that the boolean StatusSpec can't express; a press only nudges recover. */
export abstract class PresenceKeyAction extends RenderingKeyAction {
	constructor(imageFor: ImageFor) {
		super(imageFor);
	}

	override onKeyDown(): void {
		teams.recover();
	}
}
