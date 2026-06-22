import streamDeck from "@elgato/streamdeck";

import { teams } from "./teams/client";

/** Diagnostic status payload sent to the property inspector. */
function status() {
	const snapshot = teams.snapshot;
	return {
		helperRunning: teams.running,
		teamsRunning: snapshot.connected,
		inMeeting: Boolean(snapshot.state.isInMeeting),
	};
}

/**
 * Pushes diagnostic status to the property inspector whenever it is visible.
 * sendToPropertyInspector only delivers while a PI is open, so pushing on every snapshot is safe.
 */
export function registerPropertyInspector(): void {
	streamDeck.ui.onDidAppear(() => void streamDeck.ui.sendToPropertyInspector(status()));
	teams.subscribe(() => void streamDeck.ui.sendToPropertyInspector(status()));
}
