import streamDeck from "@elgato/streamdeck";

import { Availability } from "./actions/availability";
import { Leave } from "./actions/leave";
import { Applause, Laugh, Like, Love, Surprised } from "./actions/reactions";
import { InMeeting, Sharing } from "./actions/status-tiles";
import { Camera, Hand, Mute } from "./actions/toggles";
import { teams } from "./teams/client";

// Not "trace": it logs every Stream Deck↔plugin message, far noisier than needed.
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

type GlobalSettings = { allowLogReading?: boolean };

streamDeck
	.connect()
	.then(async () => {
		streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) =>
			teams.setLogReadingEnabled(ev.settings.allowLogReading === true),
		);
		// Load the opt-in before starting the helper so its first spawn gets the correct state and the tile never flashes "opt-in required". A settings failure must NOT block the helper, which would break mute/camera/hand/leave/reactions.
		try {
			const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
			teams.setLogReadingEnabled(settings.allowLogReading === true);
		} catch (error) {
			streamDeck.logger.warn(`Reading global settings failed; log reading stays off: ${error}`);
		}
		return teams.start();
	})
	.catch((error) => streamDeck.logger.error(`Startup failed: ${error}`));

// Terminate the helper on shutdown so it never outlives the plugin (it also self-exits when its stdio pipe closes).
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
