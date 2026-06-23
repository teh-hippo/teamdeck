import assert from "node:assert/strict";
import { test } from "node:test";

import { IN_MEETING, SHARING, type StatusSpec, selectStatusImage } from "../src/actions/status.ts";
import type { MeetingState, TeamsSnapshot } from "../src/teams/types.ts";

const specs: Array<{ name: string; spec: StatusSpec }> = [
	{ name: "Screen Sharing", spec: SHARING },
	{ name: "In Meeting", spec: IN_MEETING },
];

function snapshot(state: Partial<MeetingState>, connected = true): TeamsSnapshot {
	return { connected, state, permissions: {} };
}

function meetingState(spec: StatusSpec, value: boolean): Partial<MeetingState> {
	return spec.stateField === "isInMeeting" ? { isInMeeting: value } : { isInMeeting: true, [spec.stateField]: value };
}

for (const { name, spec } of specs) {
	test(`selectStatusImage(${name}) maps on and off states`, () => {
		assert.equal(selectStatusImage(spec, snapshot(meetingState(spec, true))), spec.images.on, "true maps to on");
		assert.equal(selectStatusImage(spec, snapshot(meetingState(spec, false))), spec.images.off, "false maps to off");
	});

	test(`selectStatusImage(${name}) is unavailable when disconnected`, () => {
		assert.equal(selectStatusImage(spec, snapshot(meetingState(spec, true), false)), spec.images.unavailable);
	});
}

test("out of meeting renders In Meeting off and meeting-scoped statuses unavailable", () => {
	const outOfMeeting: Partial<MeetingState> = {
		isInMeeting: false,
		isSharing: true,
	};
	assert.equal(selectStatusImage(IN_MEETING, snapshot(outOfMeeting)), IN_MEETING.images.off);
	assert.equal(selectStatusImage(SHARING, snapshot(outOfMeeting)), SHARING.images.unavailable);
});

test("empty state uses Boolean(undefined) for unavailable or off", () => {
	const empty = snapshot({});
	assert.equal(selectStatusImage(IN_MEETING, empty), IN_MEETING.images.off);
	assert.equal(selectStatusImage(SHARING, empty), SHARING.images.unavailable);
});

test("availability=false renders unavailable even in a meeting (never fakes unknown state)", () => {
	const inMeetingUnknownSharing: TeamsSnapshot = {
		connected: true,
		state: { isInMeeting: true, isSharing: undefined },
		permissions: {},
		availability: { isInMeeting: true, isSharing: false },
	};
	assert.equal(selectStatusImage(SHARING, inMeetingUnknownSharing), SHARING.images.unavailable);

	// When the field IS known (availability true), it renders the real state.
	const knownNotSharing: TeamsSnapshot = {
		connected: true,
		state: { isInMeeting: true, isSharing: false },
		permissions: {},
		availability: { isInMeeting: true, isSharing: true },
	};
	assert.equal(selectStatusImage(SHARING, knownNotSharing), SHARING.images.off);
});
