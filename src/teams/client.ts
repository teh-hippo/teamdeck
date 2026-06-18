import streamDeck from "@elgato/streamdeck";

import identity from "../../shared/identity.json";
import type { MeetingPermissions, MeetingState, ReactionType, TeamsSnapshot } from "./types";

const HOST = "ws://127.0.0.1:8124";
const PROTOCOL_VERSION = "2.0.0";
const MAX_RECONNECT_DELAY = 30_000;

type GlobalSettings = { teamsToken?: string };
type Listener = (snapshot: TeamsSnapshot) => void;

type ServerMessage = {
	tokenRefresh?: string;
	requestId?: number;
	response?: string;
	errorMsg?: string;
	meetingUpdate?: {
		meetingState?: Partial<MeetingState>;
		meetingPermissions?: Partial<MeetingPermissions>;
	};
};

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

	/** Whether a command gated by the given permission can be sent right now. */
	/** Forces a fresh connection, e.g. to recover a stale socket from a key press. */
	reconnect(): void {
		this.#connect();
	}

	isActionable(permission: keyof MeetingPermissions): boolean {
		return this.#connected && Boolean(this.#state.isInMeeting) && Boolean(this.#permissions[permission]);
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
	}

	leave(): void {
		this.#send("leave-call");
	}

	react(type: ReactionType): void {
		this.#send("send-reaction", { type });
	}

	#url(): string {
		const params = new URLSearchParams({
			"protocol-version": PROTOCOL_VERSION,
			manufacturer: identity.manufacturer,
			device: identity.device,
			app: identity.app,
			"app-version": identity.appVersion,
		});
		if (this.#token) {
			params.set("token", this.#token);
		}
		return `${HOST}?${params.toString()}`;
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
		this.#pairing = false;

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
		let message: ServerMessage;
		try {
			message = JSON.parse(raw) as ServerMessage;
		} catch {
			return;
		}

		if (typeof message.tokenRefresh === "string") {
			this.#onToken(message.tokenRefresh);
			return;
		}

		const update = message.meetingUpdate;
		if (!update) {
			return;
		}

		// Permissions and state arrive independently and as partial deltas; merge each onto the
		// cached value rather than replacing, so omitted fields are preserved.
		if (update.meetingPermissions) {
			this.#permissions = { ...this.#permissions, ...update.meetingPermissions };
		}
		if (update.meetingState) {
			this.#state = { ...this.#state, ...update.meetingState };
		}

		const canPair = update.meetingPermissions?.canPair;
		if (this.#token && canPair === true) {
			streamDeck.logger.warn("Teams token rejected; re-pairing.");
			this.#dropTokenAndRepair();
			return;
		}
		if (!this.#token && canPair === true && !this.#pairing) {
			this.#pairing = true;
			streamDeck.logger.info("Requesting Teams pairing; approve the prompt in Teams.");
			this.#send("pair");
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
