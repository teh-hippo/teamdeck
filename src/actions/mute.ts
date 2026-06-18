import { action, type DialAction, type KeyAction, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";

import { teams } from "../teams/client";
import type { TeamsSnapshot } from "../teams/types";

const DISABLED_IMAGE = "imgs/actions/mute/disabled";

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
		}
	}

	#render(target: DialAction | KeyAction, snapshot: TeamsSnapshot): void {
		if (!target.isKey()) {
			return;
		}
		const actionable = Boolean(snapshot.state.isInMeeting) && Boolean(snapshot.permissions.canToggleMute);
		if (!actionable) {
			void target.setImage(DISABLED_IMAGE);
			return;
		}
		void target.setState(snapshot.state.isMuted ? 1 : 0);
	}
}
