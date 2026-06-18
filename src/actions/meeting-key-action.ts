import { teams } from "../teams/client";
import type { MeetingPermissions } from "../teams/types";
import { RenderingKeyAction } from "./rendering-key-action";

/**
 * Shared base for Teams meeting keys. Subscribes to the client, renders every visible instance
 * via setImage (memoised), greys out when not actionable, and on press runs the command when
 * actionable or recovers the connection / re-triggers pairing otherwise. Subclasses provide the
 * gating permission, the command, and the image for a snapshot.
 */
export abstract class MeetingKeyAction extends RenderingKeyAction {
	/** The permission that gates this key's command and actionability. */
	protected abstract permission(): keyof MeetingPermissions;

	/** Performs the Teams command for this key. */
	protected abstract command(): void;

	override onKeyDown(): void {
		if (teams.isActionable(this.permission())) {
			this.command();
		} else {
			// Not actionable: recover a stuck socket or a missed pairing prompt (no-op if healthy).
			teams.recover();
		}
	}
}
