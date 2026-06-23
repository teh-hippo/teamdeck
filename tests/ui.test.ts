import assert from "node:assert/strict";
import { test } from "node:test";

import type { TeamsSnapshot } from "../src/teams/types.ts";
import { statusPayload } from "../src/ui.ts";

test("statusPayload reflects the helper, connection and meeting state", () => {
	const snapshot: TeamsSnapshot = { connected: true, state: { isInMeeting: true }, permissions: {} };
	assert.deepEqual(statusPayload(snapshot, true), { helperRunning: true, teamsRunning: true, inMeeting: true });
});

test("statusPayload coerces a missing isInMeeting to false and reflects a down helper", () => {
	const snapshot: TeamsSnapshot = { connected: false, state: {}, permissions: {} };
	assert.deepEqual(statusPayload(snapshot, false), { helperRunning: false, teamsRunning: false, inMeeting: false });
});
