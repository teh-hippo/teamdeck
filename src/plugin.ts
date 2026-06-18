import streamDeck from "@elgato/streamdeck";

import { Blur } from "./actions/blur";
import { Camera } from "./actions/camera";
import { Hand } from "./actions/hand";
import { Leave } from "./actions/leave";
import { Mute } from "./actions/mute";
import { Applause, Laugh, Like, Love, Surprised } from "./actions/reactions";
import { teams } from "./teams/client";

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

// Register with Stream Deck first, then open the Teams connection so plugin registration is
// never blocked by the external WebSocket.
streamDeck
	.connect()
	.then(() => teams.start())
	.catch((error) => streamDeck.logger.error(`Startup failed: ${error}`));
