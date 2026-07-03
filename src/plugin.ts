import streamDeck from "@elgato/streamdeck";

import { Availability } from "./actions/availability";
import { Leave } from "./actions/leave";
import { Applause, Laugh, Like, Love, Surprised } from "./actions/reactions";
import { InMeeting, Sharing } from "./actions/status-tiles";
import { Camera, Hand, Mute } from "./actions/toggles";
import { teams } from "./teams/client";
import { registerPropertyInspector } from "./ui";

// Keep the log level off "trace": it records every message between Stream Deck and the plugin and
// is far noisier than normal operation needs.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new Mute());
streamDeck.actions.registerAction(new Camera());
streamDeck.actions.registerAction(new Hand());
streamDeck.actions.registerAction(new Leave());
streamDeck.actions.registerAction(new Applause());
streamDeck.actions.registerAction(new Laugh());
streamDeck.actions.registerAction(new Like());
streamDeck.actions.registerAction(new Love());
streamDeck.actions.registerAction(new Surprised());
streamDeck.actions.registerAction(new Sharing());
streamDeck.actions.registerAction(new InMeeting());
streamDeck.actions.registerAction(new Availability());

/** The plugin's global settings; only the presence opt-in so far. */
type GlobalSettings = { allowLogReading?: boolean };

// Register with Stream Deck first, then load the presence opt-in and start the Teams helper. The
// opt-in is loaded (and applied to the client) BEFORE the helper starts, so the very first helper
// spawn is told the correct state and the Availability tile never flickers "opt-in required".
streamDeck
	.connect()
	.then(async () => {
		registerPropertyInspector();
		streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) =>
			teams.setLogReadingEnabled(ev.settings.allowLogReading === true),
		);
		// Load the opt-in before starting the helper so its first spawn is told the correct state and
		// the tile never flashes "opt-in required". A settings failure must NOT prevent the helper
		// starting — that would silently break mute/camera/hand/leave/reactions.
		try {
			const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
			teams.setLogReadingEnabled(settings.allowLogReading === true);
		} catch (error) {
			streamDeck.logger.warn(`Reading global settings failed; log reading stays off: ${error}`);
		}
		return teams.start();
	})
	.catch((error) => streamDeck.logger.error(`Startup failed: ${error}`));

// Terminate the UIA helper child process on shutdown so it never outlives the plugin. (The helper
// also exits on its own when its stdin/stdout pipe closes, which covers hard kills.)
const shutdown = (): void => teams.stop();
process.once("exit", shutdown);
process.once("SIGINT", () => {
	shutdown();
	process.exit(0);
});
process.once("SIGTERM", () => {
	shutdown();
	process.exit(0);
});
