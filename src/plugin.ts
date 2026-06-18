import streamDeck from "@elgato/streamdeck";

import { Camera } from "./actions/camera";
import { Hand } from "./actions/hand";
import { Mute } from "./actions/mute";
import { teams } from "./teams/client";

// Avoid trace logging: it records all messages between Stream Deck and the plugin, which would
// include the pairing token held in global settings.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new Mute());
streamDeck.actions.registerAction(new Camera());
streamDeck.actions.registerAction(new Hand());

// Register with Stream Deck first, then open the Teams connection so plugin registration is
// never blocked by the external WebSocket.
streamDeck
	.connect()
	.then(() => teams.start())
	.catch((error) => streamDeck.logger.error(`Startup failed: ${error}`));
