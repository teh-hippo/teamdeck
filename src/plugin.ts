import streamDeck from "@elgato/streamdeck";

import { Leave } from "./actions/leave";
import { Applause, Laugh, Like, Love, Surprised } from "./actions/reactions";
import { Blur, Camera, Hand, Mute } from "./actions/toggles";
import { InMeeting, Recording, Sharing, Unread } from "./actions/status-tiles";
import { teams } from "./teams/client";
import { registerPropertyInspector } from "./ui";

// Avoid trace logging: it records all messages between Stream Deck and the plugin, which would
// include the pairing token held in global settings.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new Mute());
streamDeck.actions.registerAction(new Camera());
streamDeck.actions.registerAction(new Hand());
streamDeck.actions.registerAction(new Blur());
streamDeck.actions.registerAction(new Leave());
streamDeck.actions.registerAction(new Applause());
streamDeck.actions.registerAction(new Laugh());
streamDeck.actions.registerAction(new Like());
streamDeck.actions.registerAction(new Love());
streamDeck.actions.registerAction(new Surprised());
streamDeck.actions.registerAction(new Recording());
streamDeck.actions.registerAction(new Sharing());
streamDeck.actions.registerAction(new Unread());
streamDeck.actions.registerAction(new InMeeting());

// Register with Stream Deck first, then open the Teams connection so plugin registration is
// never blocked by the external WebSocket.
streamDeck
	.connect()
	.then(() => {
		registerPropertyInspector();
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
