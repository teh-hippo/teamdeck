import assert from "node:assert/strict";
import { test } from "node:test";

import { CAMERA, HAND, MUTE, selectImage, type ToggleSpec } from "../src/actions/toggle.ts";
import type { TeamsSnapshot } from "../src/teams/types.ts";

function snap(state: Record<string, boolean>, permission: string): TeamsSnapshot {
	return { connected: true, paired: true, state: { isInMeeting: true, ...state }, permissions: { [permission]: true } };
}

const cases: Array<{ name: string; spec: ToggleSpec; whenTrue: Record<string, boolean> }> = [
	{ name: "Mute", spec: MUTE, whenTrue: { isMuted: true } },
	{ name: "Camera", spec: CAMERA, whenTrue: { isVideoOn: true } },
	{ name: "Hand", spec: HAND, whenTrue: { isHandRaised: true } },
];

for (const { name, spec, whenTrue } of cases) {
	test(`selectImage(${name}) maps availability and state to images`, () => {
		const disabled: TeamsSnapshot = { connected: true, paired: true, state: {}, permissions: {} };
		assert.equal(selectImage(spec, disabled), spec.images.disabled, "disabled when not actionable");
		assert.equal(selectImage(spec, snap(whenTrue, spec.permission)), spec.images.whenTrue, "whenTrue image");
		assert.equal(selectImage(spec, snap({}, spec.permission)), spec.images.whenFalse, "whenFalse image");
	});
}

test("Mute uses the inverted mapping (muted shows the red/off image)", () => {
	assert.equal(MUTE.images.whenTrue, "imgs/actions/mute/off");
	assert.equal(MUTE.images.whenFalse, "imgs/actions/mute/on");
});
