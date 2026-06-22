import assert from "node:assert/strict";
import { test } from "node:test";

import { IN_MEETING, RECORDING, selectStatusImage, SHARING, type StatusSpec, UNREAD } from "../src/actions/status.ts";
import type { MeetingState, TeamsSnapshot } from "../src/teams/types.ts";

const specs: Array<{ name: string; spec: StatusSpec }> = [
	{ name: "Recording", spec: RECORDING },
	{ name: "Screen Sharing", spec: SHARING },
	{ name: "Unread Messages", spec: UNREAD },
	{ name: "In Meeting", spec: IN_MEETING },
];

function snapshot(state: Partial<MeetingState>, connected = true, paired = true): TeamsSnapshot {
	return { connected, paired, state, permissions: {} };
}

function meetingState(spec: StatusSpec, value: boolean): Partial<MeetingState> {
	return spec.stateField === "isInMeeting"
		? { isInMeeting: value }
		: { isInMeeting: true, [spec.stateField]: value };
}

for (const { name, spec } of specs) {
	test(`selectStatusImage(${name}) maps on and off states`, () => {
		assert.equal(selectStatusImage(spec, snapshot(meetingState(spec, true))), spec.images.on, "true maps to on");
		assert.equal(selectStatusImage(spec, snapshot(meetingState(spec, false))), spec.images.off, "false maps to off");
	});

	test(`selectStatusImage(${name}) is unavailable when disconnected`, () => {
		assert.equal(selectStatusImage(spec, snapshot(meetingState(spec, true), false, true)), spec.images.unavailable);
	});

	test(`selectStatusImage(${name}) is unavailable when unpaired`, () => {
		assert.equal(selectStatusImage(spec, snapshot(meetingState(spec, true), true, false)), spec.images.unavailable);
	});
}

test("out of meeting renders In Meeting off and meeting-scoped statuses unavailable", () => {
	const outOfMeeting: Partial<MeetingState> = {
		isInMeeting: false,
		isRecordingOn: true,
		isSharing: true,
		hasUnreadMessages: true,
	};
	assert.equal(selectStatusImage(IN_MEETING, snapshot(outOfMeeting)), IN_MEETING.images.off);
	assert.equal(selectStatusImage(RECORDING, snapshot(outOfMeeting)), RECORDING.images.unavailable);
	assert.equal(selectStatusImage(SHARING, snapshot(outOfMeeting)), SHARING.images.unavailable);
	assert.equal(selectStatusImage(UNREAD, snapshot(outOfMeeting)), UNREAD.images.unavailable);
});

test("empty state uses Boolean(undefined) for unavailable or off", () => {
	const empty = snapshot({});
	assert.equal(selectStatusImage(IN_MEETING, empty), IN_MEETING.images.off);
	assert.equal(selectStatusImage(RECORDING, empty), RECORDING.images.unavailable);
	assert.equal(selectStatusImage(SHARING, empty), SHARING.images.unavailable);
	assert.equal(selectStatusImage(UNREAD, empty), UNREAD.images.unavailable);
});

test("availability=false renders unavailable even in a meeting (never fakes unknown state)", () => {
	const inMeetingUnknownRecording: TeamsSnapshot = {
		connected: true,
		paired: true,
		state: { isInMeeting: true, isRecordingOn: undefined },
		permissions: {},
		availability: { isInMeeting: true, isRecordingOn: false },
	};
	assert.equal(selectStatusImage(RECORDING, inMeetingUnknownRecording), RECORDING.images.unavailable);

	// When the field IS known (availability true), it renders the real state.
	const knownNotRecording: TeamsSnapshot = {
		connected: true,
		paired: true,
		state: { isInMeeting: true, isRecordingOn: false },
		permissions: {},
		availability: { isInMeeting: true, isRecordingOn: true },
	};
	assert.equal(selectStatusImage(RECORDING, knownNotRecording), RECORDING.images.off);
});
