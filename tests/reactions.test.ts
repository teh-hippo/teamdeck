import assert from "node:assert/strict";
import { test } from "node:test";

import { REACTIONS, selectReactionImage } from "../src/actions/toggle.ts";
import type { TeamsSnapshot } from "../src/teams/types.ts";

const actionable: TeamsSnapshot = { connected: true, state: { isInMeeting: true }, permissions: { canReact: true } };
const notInMeeting: TeamsSnapshot = { connected: true, state: {}, permissions: {} };
const disconnected: TeamsSnapshot = { connected: false, state: { isInMeeting: true }, permissions: { canReact: true } };

for (const [name, spec] of Object.entries(REACTIONS)) {
	test(`selectReactionImage(${name}) shows colour only when actionable`, () => {
		assert.equal(
			selectReactionImage(spec, actionable),
			`imgs/actions/react/${spec.image}`,
			"colour icon when actionable",
		);
		assert.equal(selectReactionImage(spec, notInMeeting), spec.disabled, "greyed icon when not in a meeting");
		assert.equal(selectReactionImage(spec, disconnected), spec.disabled, "greyed icon when disconnected");
	});
}

test("each reaction has a distinct disabled image (guards against a shared grey fallback)", () => {
	const disabled = Object.values(REACTIONS).map((s) => s.disabled);
	assert.equal(new Set(disabled).size, disabled.length, "disabled images must be per-reaction");
});

test("each reaction's disabled image is its own colour image with a -disabled suffix", () => {
	for (const spec of Object.values(REACTIONS)) {
		assert.equal(spec.disabled, `imgs/actions/react/${spec.image}-disabled`);
	}
});
