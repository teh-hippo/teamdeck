import { teams } from "../teams/client";
import type { TeamsSnapshot } from "../teams/types";
import { RenderingKeyAction } from "./rendering-key-action";
import { selectStatusImage, type StatusSpec } from "./status";

/** Read-only Teams status tile: renders live state and never sends a Teams command. */
export abstract class StatusAction extends RenderingKeyAction {
	readonly #spec: StatusSpec;

	constructor(spec: StatusSpec) {
		super();
		this.#spec = spec;
	}

	protected override imageFor(snapshot: TeamsSnapshot): string {
		return selectStatusImage(this.#spec, snapshot);
	}

	override onKeyDown(): void {
		teams.recover();
	}
}
