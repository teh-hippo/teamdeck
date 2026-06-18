import streamDeck from "@elgato/streamdeck";

import { teams } from "./teams/client";

/** Status payload sent to the property inspector. */
function status() {
	const snapshot = teams.snapshot;
	return { connected: snapshot.connected, paired: snapshot.paired, inMeeting: Boolean(snapshot.state.isInMeeting) };
}

/**
 * Wires the shared property inspector to the Teams client: pushes connection status to it and
 * handles its "re-pair" button. sendToPropertyInspector only delivers while a PI is visible, so
 * pushing on every snapshot is safe.
 */
export function registerPropertyInspector(): void {
	streamDeck.ui.onDidAppear(() => void streamDeck.ui.sendToPropertyInspector(status()));
	streamDeck.ui.onSendToPlugin((ev) => {
		const payload = ev.payload as { type?: string } | undefined;
		if (payload?.type === "repair") {
			teams.repair();
		}
	});
	teams.subscribe(() => void streamDeck.ui.sendToPropertyInspector(status()));
}
