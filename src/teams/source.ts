import type { MeetingPermissions, ReactionType, TeamsSnapshot } from "./types";

/** A subscriber to snapshot updates. */
export type Listener = (snapshot: TeamsSnapshot) => void;

/**
 * A source of Teams meeting state and control. Implemented by the legacy third-party-API client
 * (WebSocket) and by the UI-Automation helper client. The facade in `client.ts` fuses them.
 */
export interface TeamsSource {
	/** Current snapshot of connection, pairing and meeting state. */
	readonly snapshot: TeamsSnapshot;

	/** Subscribes to snapshot updates; implementations replay the current snapshot synchronously. */
	subscribe(listener: Listener): () => void;

	/** Opens the source. Safe to call more than once. */
	start(): Promise<void> | void;

	/** Whether a command gated by the given permission can be sent right now. */
	isActionable(permission: keyof MeetingPermissions): boolean;

	toggleMute(): void;
	toggleVideo(): void;
	toggleHand(): void;
	toggleBlur(): void;
	leave(): void;
	react(type: ReactionType): void;

	/** Recovers a stuck connection or re-triggers a missed pairing prompt; no-op when healthy. */
	recover(): void;

	/** Forgets any stored credential and re-initialises. */
	repair(): void;
}
