import assert from "node:assert/strict";
import { test } from "node:test";

import { BLUR, CAMERA, HAND, isActionable, MUTE, selectImage, type ToggleSpec } from "../src/actions/toggle.ts";
import type { TeamsSnapshot } from "../src/teams/types.ts";

function snap(state: Record<string, boolean>, permission: string): TeamsSnapshot {
	return { connected: true, paired: true, state: { isInMeeting: true, ...state }, permissions: { [permission]: true } };
}

const cases: Array<{ name: string; spec: ToggleSpec; whenTrue: Record<string, boolean> }> = [
	{ name: "Mute", spec: MUTE, whenTrue: { isMuted: true } },
	{ name: "Camera", spec: CAMERA, whenTrue: { isVideoOn: true } },
	{ name: "Hand", spec: HAND, whenTrue: { isHandRaised: true } },
	{ name: "Blur", spec: BLUR, whenTrue: { isBackgroundBlurred: true } },
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

test("isActionable gates on connected, in a meeting, and the permission", () => {
	const base: TeamsSnapshot = {
		connected: true,
		paired: true,
		state: { isInMeeting: true },
		permissions: { canReact: true },
	};
	assert.equal(isActionable(base, "canReact"), true);
	assert.equal(isActionable({ ...base, connected: false }, "canReact"), false);
	assert.equal(isActionable({ ...base, state: {} }, "canReact"), false);
	assert.equal(isActionable({ ...base, permissions: {} }, "canReact"), false);
});
