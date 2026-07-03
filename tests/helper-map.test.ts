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
			hand: sig(false),
			sharing: sig(false, true, "uia-window"),
		},
		...overrides,
	};
}

test("maps mute/camera/sharing values and in-meeting", () => {
	const s = mapHelperSnapshot(helperSnap());
	assert.equal(s.connected, true);
	assert.equal(s.state.isInMeeting, true);
	assert.equal(s.state.isMuted, false, "value false => unmuted");
	assert.equal(s.state.isVideoOn, true);
	assert.equal(s.state.isSharing, false);
	assert.equal(s.state.isHandRaised, false, "hand now readable from the toolbar button");
	assert.equal(s.availability?.isHandRaised, true);
});

test("muted maps to isMuted true; sharing maps to isSharing", () => {
	const s = mapHelperSnapshot(
		helperSnap({ signals: { ...helperSnap().signals, mute: sig(true), sharing: sig(true, true, "uia-window") } }),
	);
	assert.equal(s.state.isMuted, true);
	assert.equal(s.state.isSharing, true);
});

test("synthesizes permissions from availability and meeting (B1)", () => {
	const s = mapHelperSnapshot(helperSnap());
	assert.equal(s.permissions.canToggleMute, true);
	assert.equal(s.permissions.canToggleVideo, true);
	assert.equal(s.permissions.canToggleHand, true, "hand actionable when its state label is readable, like mute/camera");
	assert.equal(s.permissions.canLeave, true);
	assert.equal(s.permissions.canReact, true);
});

test("unknown signals are undefined and marked unavailable (B2 - never fake state)", () => {
	const s = mapHelperSnapshot(
		helperSnap({ signals: { ...helperSnap().signals, hand: sig(null, false, "uia-label?:Handzeichen") } }),
	);
	assert.equal(s.state.isHandRaised, undefined, "an unreadable hand label renders unknown");
	assert.equal(s.availability?.isHandRaised, false);
	assert.equal(s.permissions.canToggleHand, false, "an unreadable hand greys and disables the key");
	assert.ok(
		s.labelIssues?.some((i) => i.includes("hand") && i.includes("Handzeichen")),
		"an unrecognised hand label surfaces as a labelIssue",
	);
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
				hand: sig(null, false, "none"),
				sharing: sig(null, false, "none"),
			},
		}),
	);
	assert.equal(s.state.isInMeeting, false);
	assert.equal(s.permissions.canToggleMute, false);
	assert.equal(s.permissions.canToggleVideo, false);
	assert.equal(s.permissions.canToggleHand, false);
	assert.equal(s.permissions.canLeave, false);
	assert.equal(s.state.isMuted, undefined);
});

test("teamsRunning false maps to disconnected", () => {
	const s = mapHelperSnapshot(helperSnap({ teamsRunning: false, inMeeting: false }));
	assert.equal(s.connected, false);
});

test("an available-but-null signal is unknown, never a fake off state", () => {
	// The helper marks a control available but reports a null (unreadable) value.
	const s = mapHelperSnapshot(helperSnap({ signals: { ...helperSnap().signals, mute: sig(null, true, "uia-label") } }));
	assert.equal(s.state.isMuted, undefined, "null value must not collapse to false");
	assert.equal(s.availability?.isMuted, false, "available-but-null must render unknown, not off");
});

test("an unrecognised control label surfaces as a labelIssue diagnostic", () => {
	const s = mapHelperSnapshot(
		helperSnap({ signals: { ...helperSnap().signals, mute: sig(null, false, "uia-label?:Stumm") } }),
	);
	assert.equal(s.state.isMuted, undefined, "an unreadable label renders unknown, never a fake state");
	assert.ok(
		s.labelIssues?.some((i) => i.includes("mute") && i.includes("Stumm")),
		"the offending control and its raw label are reported",
	);
});

test("all-recognised labels produce no labelIssues", () => {
	assert.equal(mapHelperSnapshot(helperSnap()).labelIssues, undefined);
});

test("maps presence from the helper field", () => {
	const s = mapHelperSnapshot(helperSnap({ presence: { value: "doNotDisturb", known: true, source: "teams-log" } }));
	assert.equal(s.presence?.value, "doNotDisturb");
	assert.equal(s.presence?.known, true);
	assert.equal(s.presence?.source, "teams-log");
});

test("an older helper without a presence field still maps mute/camera and reports unknown presence", () => {
	// A stale helper binary emits no `presence`; the mapping must stay defensive rather than throw,
	// which would discard the whole snapshot (dropping mute/camera too).
	const s = mapHelperSnapshot(helperSnap());
	assert.equal(s.state.isMuted, false, "mute still maps");
	assert.equal(s.state.isVideoOn, true, "camera still maps");
	assert.equal(s.presence?.value, "unknown");
	assert.equal(s.presence?.known, false);
	assert.equal(s.presence?.source, "none");
});

test("an unrecognised presence token renders unknown and is never surfaced as the raw token", () => {
	const s = mapHelperSnapshot(helperSnap({ presence: { value: "Presenting", known: true, source: "teams-log" } }));
	assert.equal(s.presence?.value, "unknown");
	assert.equal(s.presence?.known, false);
});

test("the disabled source is preserved so the tile can tell opt-in-off from a live read", () => {
	const s = mapHelperSnapshot(helperSnap({ presence: { value: "unknown", known: false, source: "disabled" } }));
	assert.equal(s.presence?.source, "disabled");
});
