import assert from "node:assert/strict";
import { test } from "node:test";

import type { TeamsSnapshot } from "../src/teams/types.ts";
import { statusPayload } from "../src/ui.ts";

test("statusPayload reflects the helper, connection and meeting state", () => {
	const snapshot: TeamsSnapshot = { connected: true, state: { isInMeeting: true }, permissions: {} };
	assert.deepEqual(statusPayload(snapshot, true), {
		helperRunning: true,
		teamsRunning: true,
		inMeeting: true,
		presence: "unknown",
		logReadingAllowed: false,
	});
});

test("statusPayload coerces a missing isInMeeting to false and reflects a down helper", () => {
	const snapshot: TeamsSnapshot = { connected: false, state: {}, permissions: {} };
	assert.deepEqual(statusPayload(snapshot, false), {
		helperRunning: false,
		teamsRunning: false,
		inMeeting: false,
		presence: "unknown",
		logReadingAllowed: false,
	});
});

test("statusPayload surfaces the presence enum and opt-in when allowed", () => {
	const snapshot: TeamsSnapshot = {
		connected: true,
		state: { isInMeeting: false },
		permissions: {},
		presence: { value: "busy", known: true, source: "teams-log" },
		logReadingAllowed: true,
	};
	assert.deepEqual(statusPayload(snapshot, true), {
		helperRunning: true,
		teamsRunning: true,
		inMeeting: false,
		presence: "busy",
		logReadingAllowed: true,
	});
});

test("statusPayload carries only the presence enum, never the helper source or any raw log text", () => {
	const snapshot: TeamsSnapshot = {
		connected: true,
		state: {},
		permissions: {},
		presence: { value: "away", known: true, source: "teams-log" },
		logReadingAllowed: true,
	};
	const payload = statusPayload(snapshot, true) as Record<string, unknown>;
	const KNOWN = new Set(["available", "busy", "doNotDisturb", "beRightBack", "away", "offline", "unknown"]);
	assert.ok(KNOWN.has(payload.presence as string), "presence is a known enum string");
	assert.equal(payload.source, undefined, "the helper's source string is never forwarded");
	assert.deepEqual(
		Object.keys(payload).sort(),
		["helperRunning", "inMeeting", "logReadingAllowed", "presence", "teamsRunning"],
		"only the whitelisted diagnostic fields are present",
	);
});
