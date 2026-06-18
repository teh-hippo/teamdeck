import { action, type DialAction, type KeyAction, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import type { TeamsSnapshot } from "../teams/types";

const IMAGE = {
	live: "imgs/actions/mute/on",
	muted: "imgs/actions/mute/off",
	disabled: "imgs/actions/mute/disabled",
};

/**
 * Toggles the Microsoft Teams microphone and mirrors live mute state on the key.
 *
 * State 0 = live (unmuted), state 1 = muted. The key is greyed when not in a meeting or when
 * Teams reports the mute control as unavailable.
 */
@action({ UUID: "io.github.teh-hippo.teamdeck.mute" })
export class Mute extends SingletonAction {
	constructor() {
		super();
		// A single subscription drives every visible instance of this action.
		teams.subscribe((snapshot) => {
			for (const visible of this.actions) {
				this.#render(visible, snapshot);
			}
		});
	}

	override onWillAppear(ev: WillAppearEvent): void {
		this.#render(ev.action, teams.snapshot);
	}

	override onKeyDown(): void {
		if (teams.isActionable("canToggleMute")) {
			teams.toggleMute();
		} else if (!teams.snapshot.connected) {
			// Recover a possibly-stale socket on press.
			teams.reconnect();
		}
	}

	#render(target: DialAction | KeyAction, snapshot: TeamsSnapshot): void {
		if (!target.isKey()) {
			return;
		}
		const actionable =
			snapshot.connected && Boolean(snapshot.state.isInMeeting) && Boolean(snapshot.permissions.canToggleMute);
		// Render purely via setImage: setState alone cannot clear a previous setImage override.
		const image = !actionable ? IMAGE.disabled : snapshot.state.isMuted ? IMAGE.muted : IMAGE.live;
		void target.setImage(image);
	}
}
