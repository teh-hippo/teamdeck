import { HelperClient } from "./helper";
import { LegacyClient } from "./legacy";
import type { Listener, TeamsSource } from "./source";
import type { MeetingPermissions, ReactionType, TeamsSnapshot } from "./types";

const HELPER_START_DELAY = 4_000;

/**
 * Fuses the legacy third-party-API client with the UI-Automation helper.
 *
 * The legacy API is preferred while connected (richer, lower-latency, non-intrusive). When it is
 * unavailable — after the 30 June 2026 retirement, or when the user has not enabled it — the helper
 * takes over automatically. The helper only runs while the legacy API is down, to avoid the UIA
 * polling cost when it is not needed. Actions and the property inspector talk only to this facade.
 */
class TeamsFacade implements TeamsSource {
	readonly #legacy = new LegacyClient();
	readonly #helper = new HelperClient();
	readonly #listeners = new Set<Listener>();
	#helperStartTimer?: ReturnType<typeof setTimeout>;
	#started = false;

	/** The snapshot of whichever source is currently active. */
	get snapshot(): TeamsSnapshot {
		return this.#active().snapshot;
	}

	/** The legacy API is the active source only when connected AND paired (i.e. fully working). */
	#legacyActive(): boolean {
		return this.#legacy.snapshot.connected && this.#legacy.snapshot.paired;
	}

	#active(): TeamsSource {
		return this.#legacyActive() ? this.#legacy : this.#helper;
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		listener(this.snapshot);
		return () => this.#listeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.#started) {
			return;
		}
		this.#started = true;
		this.#legacy.subscribe(() => {
			this.#manageHelper();
			this.#emit();
		});
		this.#helper.subscribe(() => this.#emit());
		await this.#legacy.start();
	}

	/** Stops the helper child process; call on plugin shutdown to avoid orphaned UIA pollers. */
	stop(): void {
		clearTimeout(this.#helperStartTimer);
		this.#helperStartTimer = undefined;
		this.#helper.stop();
	}

	/** Runs the helper only while the legacy API is not active (debounced to avoid thrashing). */
	#manageHelper(): void {
		if (this.#legacyActive()) {
			clearTimeout(this.#helperStartTimer);
			this.#helperStartTimer = undefined;
			this.#helper.stop();
		} else if (this.#helperStartTimer === undefined) {
			this.#helperStartTimer = setTimeout(() => {
				this.#helperStartTimer = undefined;
				if (!this.#legacyActive()) {
					this.#helper.start();
				}
			}, HELPER_START_DELAY);
		}
	}

	isActionable(permission: keyof MeetingPermissions): boolean {
		return this.#active().isActionable(permission);
	}

	toggleMute(): void {
		this.#active().toggleMute();
	}

	toggleVideo(): void {
		this.#active().toggleVideo();
	}

	toggleHand(): void {
		this.#active().toggleHand();
	}

	toggleBlur(): void {
		this.#active().toggleBlur();
	}

	leave(): void {
		this.#active().leave();
	}

	react(type: ReactionType): void {
		this.#active().react(type);
	}

	recover(): void {
		this.#active().recover();
	}

	repair(): void {
		this.#active().repair();
	}

	#emit(): void {
		const snapshot = this.snapshot;
		for (const listener of this.#listeners) {
			listener(snapshot);
		}
	}
}

/** The shared Teams source for the plugin process (legacy third-party API + UIA helper). */
export const teams = new TeamsFacade();
