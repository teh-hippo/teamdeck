import streamDeck from "@elgato/streamdeck";

import identity from "../../shared/identity.json";
import { actionable, buildUrl, mergePermissions, mergeState, pairingDecision, parseMessage } from "./protocol";
import type { MeetingPermissions, MeetingState, ReactionType, TeamsSnapshot } from "./types";

const MAX_RECONNECT_DELAY = 30_000;

type GlobalSettings = { teamsToken?: string };
type Listener = (snapshot: TeamsSnapshot) => void;

/**
 * Single shared connection to the Microsoft Teams third-party app API.
 *
 * Owns pairing, token persistence (in Stream Deck global settings), reconnection with backoff,
 * and the cached meeting state, broadcasting snapshots to subscribed actions. The protocol it
 * speaks is documented and empirically verified in `agent/specs/protocol.md`.
 */
class TeamsClient {
	#ws?: WebSocket;
	#abort?: AbortController;
	#token?: string;
	#pairing = false;
	#requestId = 0;
	#reconnectDelay = 1_000;
	#reconnectTimer?: ReturnType<typeof setTimeout>;
	#started = false;
	#connected = false;
	#state: Partial<MeetingState> = {};
	#permissions: Partial<MeetingPermissions> = {};
	readonly #listeners = new Set<Listener>();

	/** Current snapshot of connection, pairing and meeting state. */
	get snapshot(): TeamsSnapshot {
		return {
			connected: this.#connected,
			paired: Boolean(this.#token),
			state: { ...this.#state },
			permissions: { ...this.#permissions },
		};
	}

	/** Subscribes to snapshot updates; immediately replays the current snapshot. */
	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		listener(this.snapshot);
		return () => this.#listeners.delete(listener);
	}

	/** Loads any persisted token and opens the connection. Safe to call more than once. */
	async start(): Promise<void> {
		if (this.#started) {
			return;
		}
		this.#started = true;
		const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
		this.#token = settings.teamsToken || undefined;
		this.#connect();
	}

	/** Forces a fresh connection, e.g. for a manual re-pair from the property inspector. */
	reconnect(): void {
		if (this.#ws?.readyState === WebSocket.CONNECTING) {
			return;
		}
		this.#connect();
	}

	/** Recovers a stuck connection or re-triggers a missed pairing prompt; no-op when healthy. */
	recover(): void {
		if (!this.#connected || (!this.#token && this.#permissions.canPair === true)) {
			this.#connect();
		}
	}

	/** Whether a command gated by the given permission can be sent right now. */
	isActionable(permission: keyof MeetingPermissions): boolean {
		return actionable(this.snapshot, permission);
	}

	toggleMute(): void {
		this.#send("toggle-mute");
	}

	toggleVideo(): void {
		this.#send("toggle-video");
	}

	toggleHand(): void {
		this.#send("toggle-hand");
	}

	toggleBlur(): void {
		this.#send("toggle-background-blur");
		// Teams does not echo blur changes, so optimistically flip the cached value and emit so
		// the key reflects the toggle. A later full snapshot reconciles the real value.
		if (this.#state.isInMeeting) {
			this.#state = { ...this.#state, isBackgroundBlurred: !this.#state.isBackgroundBlurred };
			this.#emit();
		}
	}

	leave(): void {
		this.#send("leave-call");
	}

	react(type: ReactionType): void {
		this.#send("send-reaction", { type });
	}

	#url(): string {
		return buildUrl(identity, this.#token);
	}

	#connect(): void {
		clearTimeout(this.#reconnectTimer);
		// Tear down any previous socket and its listeners so two never run at once; the protocol
		// notes warn that concurrent same-identity sockets can revoke the token.
		this.#abort?.abort();
		try {
			this.#ws?.close();
		} catch {
			// ignore
		}
		// Reset connection state here. On a manual reconnect the abort above suppresses the old
		// socket's close handler, so clear the caches now to avoid emitting a stale, actionable
		// snapshot during the reconnect window.
		this.#pairing = false;
		this.#connected = false;
		this.#state = {};
		this.#permissions = {};
		this.#emit();

		const paired = Boolean(this.#token);
		const abort = new AbortController();
		this.#abort = abort;
		const ws = new WebSocket(this.#url());
		this.#ws = ws;

		ws.addEventListener(
			"open",
			() => {
				this.#connected = true;
				this.#reconnectDelay = 1_000;
				streamDeck.logger.info(`Teams connected (paired: ${paired}).`);
				this.#emit();
			},
			{ signal: abort.signal },
		);
		ws.addEventListener(
			"message",
			(ev) => this.#onMessage(typeof ev.data === "string" ? ev.data : String(ev.data)),
			{ signal: abort.signal },
		);
		ws.addEventListener(
			"close",
			() => {
				this.#connected = false;
				this.#state = {};
				this.#permissions = {};
				this.#emit();
				streamDeck.logger.info("Teams connection closed; reconnecting.");
				this.#scheduleReconnect();
			},
			{ signal: abort.signal },
		);
		ws.addEventListener(
			"error",
			() => {
				// Some failures (e.g. connection refused) emit only `error`; ensure a retry.
				if (!this.#connected) {
					this.#scheduleReconnect();
				}
			},
			{ signal: abort.signal },
		);
	}

	#scheduleReconnect(): void {
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = setTimeout(() => this.#connect(), this.#reconnectDelay);
		this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, MAX_RECONNECT_DELAY);
	}

	#onMessage(raw: string): void {
		const message = parseMessage(raw);
		if (!message) {
			return;
		}

		if (typeof message.tokenRefresh === "string") {
			this.#onToken(message.tokenRefresh);
			return;
		}
		if (message.errorMsg) {
			streamDeck.logger.warn(`Teams error: ${message.errorMsg} (requestId=${message.requestId}).`);
		}

		const update = message.meetingUpdate;
		if (!update) {
			return;
		}

		// Observed messages are full snapshots; merge defensively in case a partial ever arrives.
		this.#permissions = mergePermissions(this.#permissions, update.meetingPermissions);
		this.#state = mergeState(this.#state, update.meetingState);

		const canPair = update.meetingPermissions?.canPair;
		if (canPair === false) {
			// Allow a future pairing attempt, e.g. after the user dismissed the previous prompt.
			this.#pairing = false;
		}

		switch (pairingDecision(Boolean(this.#token), canPair)) {
			case "repair":
				streamDeck.logger.warn("Teams token rejected; re-pairing.");
				this.#dropTokenAndRepair();
				return;
			case "pair":
				if (!this.#pairing) {
					this.#pairing = true;
					streamDeck.logger.info("Requesting Teams pairing; approve the prompt in Teams.");
					this.#send("pair");
				}
				break;
		}

		this.#emit();
	}

	#onToken(token: string): void {
		const firstPairing = !this.#token;
		this.#token = token;
		this.#pairing = false;
		void streamDeck.settings.setGlobalSettings<GlobalSettings>({ teamsToken: token });
		streamDeck.logger.info("Teams pairing token stored.");
		if (firstPairing) {
			// Close the tokenless socket; the close handler reconnects once, now with the token.
			// Closing rather than calling #connect() directly avoids two briefly-concurrent sockets.
			this.#closeForReconnect();
		}
	}

	#dropTokenAndRepair(): void {
		this.#token = undefined;
		void streamDeck.settings.setGlobalSettings<GlobalSettings>({});
		this.#closeForReconnect();
	}

	#closeForReconnect(): void {
		try {
			this.#ws?.close();
		} catch {
			// Ignore; the close handler schedules the single reconnect.
		}
	}

	#send(action: string, parameters: Record<string, unknown> = {}): void {
		if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
			streamDeck.logger.warn(`Cannot send "${action}": Teams not connected.`);
			if (!this.#connected) {
				this.#connect();
			}
			return;
		}
		this.#ws.send(JSON.stringify({ action, parameters, requestId: ++this.#requestId }));
	}

	#emit(): void {
		const snapshot = this.snapshot;
		for (const listener of this.#listeners) {
			listener(snapshot);
		}
	}
}

/** The shared Teams client instance for the plugin process. */
export const teams = new TeamsClient();
