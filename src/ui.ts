import streamDeck from "@elgato/streamdeck";

import { teams } from "./teams/client";
import type { TeamsSnapshot } from "./teams/types";

/** Diagnostic status payload sent to the property inspector. */
export type StatusPayload = { helperRunning: boolean; teamsRunning: boolean; inMeeting: boolean };

/** Derives the diagnostic status payload from a snapshot and whether the helper is running. */
export function statusPayload(snapshot: TeamsSnapshot, helperRunning: boolean): StatusPayload {
	return {
		helperRunning,
		teamsRunning: snapshot.connected,
		inMeeting: Boolean(snapshot.state.isInMeeting),
	};
}

/**
 * Pushes diagnostic status to the property inspector whenever it is visible.
 * sendToPropertyInspector only delivers while a PI is open, so pushing on every snapshot is safe.
 */
export function registerPropertyInspector(): void {
	const push = (): void => void streamDeck.ui.sendToPropertyInspector(statusPayload(teams.snapshot, teams.running));
	streamDeck.ui.onDidAppear(push);
	teams.subscribe(push);
}
