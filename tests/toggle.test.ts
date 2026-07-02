import assert from "node:assert/strict";
import { test } from "node:test";

import { CAMERA, HAND, isActionable, MUTE, REACTIONS, selectImage, type ToggleSpec } from "../src/actions/toggle.ts";
import type { TeamsSnapshot } from "../src/teams/types.ts";

function snap(state: Record<string, boolean>, permission: string): TeamsSnapshot {
	return { connected: true, state: { isInMeeting: true, ...state }, permissions: { [permission]: true } };
}

const cases: Array<{ name: string; spec: ToggleSpec; whenTrue: Record<string, boolean> }> = [
	{ name: "Mute", spec: MUTE, whenTrue: { isMuted: true } },
	{ name: "Camera", spec: CAMERA, whenTrue: { isVideoOn: true } },
	{ name: "Hand", spec: HAND, whenTrue: { isHandRaised: true } },
];

for (const { name, spec, whenTrue } of cases) {
	test(`selectImage(${name}) maps availability and state to images`, () => {
		const disabled: TeamsSnapshot = { connected: true, state: {}, permissions: {} };
		assert.equal(selectImage(spec, disabled), spec.images.disabled, "disabled when not actionable");
		assert.equal(selectImage(spec, snap(whenTrue, spec.permission)), spec.images.whenTrue, "whenTrue image");
		assert.equal(selectImage(spec, snap({}, spec.permission)), spec.images.whenFalse, "whenFalse image");
	});
}

test("Mute uses the inverted mapping (muted shows the red/off image)", () => {
	assert.equal(MUTE.images.whenTrue, "imgs/actions/mute/off");
	assert.equal(MUTE.images.whenFalse, "imgs/actions/mute/on");
});

test("reactions map to the verified wire types (Surprised => wow)", () => {
	assert.equal(REACTIONS.applause.type, "applause");
	assert.equal(REACTIONS.laugh.type, "laugh");
	assert.equal(REACTIONS.like.type, "like");
	assert.equal(REACTIONS.love.type, "love");
	assert.equal(REACTIONS.surprised.type, "wow");
});

test("isActionable gates on connected, in a meeting, and the permission", () => {
	const base: TeamsSnapshot = {
		connected: true,
		state: { isInMeeting: true },
		permissions: { canReact: true },
	};
	assert.equal(isActionable(base, "canReact"), true);
	assert.equal(isActionable({ ...base, connected: false }, "canReact"), false);
	assert.equal(isActionable({ ...base, state: {} }, "canReact"), false);
	assert.equal(isActionable({ ...base, permissions: {} }, "canReact"), false);
});

test("selectImage renders disabled when the field is unavailable (never fakes unknown state)", () => {
	// Unit guard for selectImage: permission true + availability false. mapHelperSnapshot no longer
	// produces this pair for hand (an unreadable hand now also disables the permission), but
	// selectImage must still render disabled on unknown state regardless of the permission.
	const handUnknown: TeamsSnapshot = {
		connected: true,
		state: { isInMeeting: true, isHandRaised: undefined },
		permissions: { canToggleHand: true },
		availability: { isInMeeting: true, isHandRaised: false },
	};
	assert.equal(selectImage(HAND, handUnknown), HAND.images.disabled, "unknown state must not render whenFalse");

	// When the field IS known, the real state still renders even with an availability map present.
	const handRaisedKnown: TeamsSnapshot = {
		connected: true,
		state: { isInMeeting: true, isHandRaised: true },
		permissions: { canToggleHand: true },
		availability: { isInMeeting: true, isHandRaised: true },
	};
	assert.equal(selectImage(HAND, handRaisedKnown), HAND.images.whenTrue);
});
