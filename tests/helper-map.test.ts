import assert from "node:assert/strict";
import { test } from "node:test";

import { type HelperSignal, type HelperSnapshot, mapHelperSnapshot } from "../src/teams/helper-map.ts";

function sig(value: boolean | null, available = true, source = "uia-label"): HelperSignal {
	return { value, available, source };
}

function helperSnap(overrides: Partial<HelperSnapshot> = {}): HelperSnapshot {
	return {
		teamsRunning: true,
		inMeeting: true,
		window: { pid: 1, name: "Meeting with X | Microsoft Teams" },
		signals: {
			mute: sig(false),
			camera: sig(true),
			hand: sig(null, false, "flyout-only"),
			sharing: sig(false, true, "uia-window"),
			recording: sig(null, false, "none"),
			unread: sig(null, false, "none"),
		},
		...overrides,
	};
}

test("maps mute/camera/sharing values and in-meeting", () => {
	const s = mapHelperSnapshot(helperSnap());
	assert.equal(s.connected, true);
	assert.equal(s.paired, true);
	assert.equal(s.state.isInMeeting, true);
	assert.equal(s.state.isMuted, false, "value false => unmuted");
	assert.equal(s.state.isVideoOn, true);
	assert.equal(s.state.isSharing, false);
});

test("muted maps to isMuted true; canStopSharing follows sharing", () => {
	const s = mapHelperSnapshot(
		helperSnap({ signals: { ...helperSnap().signals, mute: sig(true), sharing: sig(true, true, "uia-window") } }),
	);
	assert.equal(s.state.isMuted, true);
	assert.equal(s.state.isSharing, true);
	assert.equal(s.permissions.canStopSharing, true);
});

test("synthesizes permissions from availability and meeting (B1)", () => {
	const s = mapHelperSnapshot(helperSnap());
	assert.equal(s.permissions.canToggleMute, true);
	assert.equal(s.permissions.canToggleVideo, true);
	assert.equal(s.permissions.canToggleHand, true, "hand is control-only but actionable in a meeting");
	assert.equal(s.permissions.canLeave, true);
	assert.equal(s.permissions.canReact, true);
	assert.equal(s.permissions.canToggleBlur, false, "blur control not implemented via UIA");
	assert.equal(s.permissions.canPair, false);
});

test("unknown signals are undefined and marked unavailable (B2 - never fake state)", () => {
	const s = mapHelperSnapshot(helperSnap());
	assert.equal(s.state.isRecordingOn, undefined);
	assert.equal(s.state.hasUnreadMessages, undefined);
	assert.equal(s.state.isHandRaised, undefined, "hand state is behind the flyout, not readable");
	assert.equal(s.availability?.isRecordingOn, false);
	assert.equal(s.availability?.hasUnreadMessages, false);
	assert.equal(s.availability?.isHandRaised, false);
	assert.equal(s.availability?.isMuted, true, "mute is readable");
	assert.equal(s.availability?.isInMeeting, true);
});

test("out of meeting: no command permissions, mute/camera unavailable", () => {
	const s = mapHelperSnapshot(
		helperSnap({
			inMeeting: false,
			signals: {
				mute: sig(null, false, "none"),
				camera: sig(null, false, "none"),
				hand: sig(null, false, "flyout-only"),
				sharing: sig(null, false, "none"),
				recording: sig(null, false, "none"),
				unread: sig(null, false, "none"),
			},
		}),
	);
	assert.equal(s.state.isInMeeting, false);
	assert.equal(s.permissions.canToggleMute, false);
	assert.equal(s.permissions.canToggleVideo, false);
	assert.equal(s.permissions.canLeave, false);
	assert.equal(s.state.isMuted, undefined);
});

test("teamsRunning false maps to disconnected", () => {
	const s = mapHelperSnapshot(helperSnap({ teamsRunning: false, inMeeting: false }));
	assert.equal(s.connected, false);
});
