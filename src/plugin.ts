import streamDeck from "@elgato/streamdeck";

import { Mute } from "./actions/mute";
import { teams } from "./teams/client";

// Avoid trace logging: it records all messages between Stream Deck and the plugin, which would
// include the pairing token held in global settings.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new Mute());

// Register with Stream Deck first, then open the Teams connection so plugin registration is
// never blocked by the external WebSocket.
streamDeck.connect().then(() => teams.start());
