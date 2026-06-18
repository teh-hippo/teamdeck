import type { MeetingPermissions, MeetingState, TeamsSnapshot } from "./types";

export const HOST = "ws://127.0.0.1:8124";
export const PROTOCOL_VERSION = "2.0.0";

/** The pairing identity tuple Teams binds the token to (from shared/identity.json). */
export type Identity = {
	manufacturer: string;
	device: string;
	app: string;
	appVersion: string;
};

/** Inbound message shapes from the Teams third-party app API. */
export type ServerMessage = {
	tokenRefresh?: string;
	requestId?: number;
	response?: string;
	errorMsg?: string;
	meetingUpdate?: {
		meetingState?: Partial<MeetingState>;
		meetingPermissions?: Partial<MeetingPermissions>;
	};
};

export type PairingDecision = "pair" | "repair" | "none";

/** Builds the connection URL. The token is omitted entirely when absent (verified behaviour). */
export function buildUrl(identity: Identity, token?: string): string {
	const params = new URLSearchParams({
		"protocol-version": PROTOCOL_VERSION,
		manufacturer: identity.manufacturer,
		device: identity.device,
		app: identity.app,
		"app-version": identity.appVersion,
	});
	if (token) {
		params.set("token", token);
	}
	return `${HOST}?${params.toString()}`;
}

/** Parses a raw inbound frame, or returns null when it is not JSON. */
export function parseMessage(raw: string): ServerMessage | null {
	try {
		return JSON.parse(raw) as ServerMessage;
	} catch {
		return null;
	}
}

/**
 * Merges an inbound meetingState onto the cached state. Observed messages are full snapshots,
 * but the merge is defensive so a partial (from another Teams version) would not reset fields.
 */
export function mergeState(prev: Partial<MeetingState>, delta?: Partial<MeetingState>): Partial<MeetingState> {
	return delta ? { ...prev, ...delta } : prev;
}

/** Merges an inbound meetingPermissions onto the cached permissions (defensive, as above). */
export function mergePermissions(
	prev: Partial<MeetingPermissions>,
	delta?: Partial<MeetingPermissions>,
): Partial<MeetingPermissions> {
	return delta ? { ...prev, ...delta } : prev;
}

/** Pairing decision from the current token and the latest canPair flag. */
export function pairingDecision(hasToken: boolean, canPair: boolean | undefined): PairingDecision {
	if (canPair !== true) {
		return "none";
	}
	return hasToken ? "repair" : "pair";
}

/** Whether a command gated by the given permission can run, given a snapshot. */
export function actionable(snapshot: TeamsSnapshot, permission: keyof MeetingPermissions): boolean {
	return snapshot.connected && Boolean(snapshot.state.isInMeeting) && Boolean(snapshot.permissions[permission]);
}
