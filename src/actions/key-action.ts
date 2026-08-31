import streamDeck, {
	type DialAction,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { teams } from "../teams/client";
import type { MeetingPermissions, TeamsSnapshot } from "../teams/types";
import { isActionable } from "./toggle";

type ImageFor = (snapshot: TeamsSnapshot) => string;

/** Base for Teams keys that render live state: subscribes and re-renders every visible instance via setImage (memoised); subclasses supply the selector. */
abstract class RenderingKeyAction extends SingletonAction {
	readonly #images = new Map<string, { desired: string; applied?: string; running: boolean }>();
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
		this.#images.delete(ev.action.id);
	}

	#render(target: DialAction | KeyAction, snapshot: TeamsSnapshot): void {
		if (!target.isKey()) {
			return;
		}
		// Render purely via setImage: setState alone cannot clear a previous setImage override.
		const desired = this.#imageFor(snapshot);
		const state = this.#images.get(target.id) ?? { desired, running: false };
		state.desired = desired;
		this.#images.set(target.id, state);
		if (state.running || state.applied === desired) {
			return;
		}
		state.running = true;
		void this.#applyImages(target, state);
	}

	async #applyImages(target: KeyAction, state: { desired: string; applied?: string; running: boolean }): Promise<void> {
		let failed = false;
		try {
			while (this.#images.get(target.id) === state && state.applied !== state.desired) {
				const image = state.desired;
				await target.setImage(image);
				state.applied = image;
			}
		} catch (error) {
			failed = true;
			streamDeck.logger.warn(`Stream Deck image update failed for ${target.id}: ${String(error)}`);
		} finally {
			state.running = false;
			if (!failed && this.#images.get(target.id) === state && state.applied !== state.desired) {
				this.#render(target, teams.snapshot);
			}
		}
	}
}

export type KeyConfig = {
	permission: keyof MeetingPermissions;
	command: () => Promise<boolean>;
	imageFor: ImageFor;
};

/** Base for Teams meeting keys: on press, runs the command when actionable, else nudges the helper to recover (no-op when healthy). */
export abstract class MeetingKeyAction extends RenderingKeyAction {
	readonly #permission: keyof MeetingPermissions;
	readonly #command: () => Promise<boolean>;

	constructor(config: KeyConfig) {
		super(config.imageFor);
		this.#permission = config.permission;
		this.#command = config.command;
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		if (isActionable(teams.snapshot, this.#permission)) {
			if (!(await this.#command())) {
				await ev.action.showAlert();
			}
		} else {
			teams.recover();
			await ev.action.showAlert();
		}
	}
}

export abstract class ReadOnlyKeyAction extends RenderingKeyAction {
	override onKeyDown(): void {
		teams.recover();
	}
}
