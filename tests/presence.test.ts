import assert from "node:assert/strict";
import { test } from "node:test";

import { selectPresenceImage } from "../src/actions/presence.ts";
import type { Presence, TeamsSnapshot } from "../src/teams/types.ts";

function snap(over: Partial<TeamsSnapshot> = {}): TeamsSnapshot {
	return {
		connected: true,
		state: {},
		permissions: {},
		logReadingAllowed: true,
		presence: { value: "available", known: true, source: "teams-log" },
		...over,
	};
}

test("opt-in off renders opt-in required regardless of a known presence", () => {
	const s = snap({ logReadingAllowed: false, presence: { value: "busy", known: true, source: "teams-log" } });
	assert.ok(selectPresenceImage(s).endsWith("/optin"));
});

test("opt-in unknown (settings not loaded yet) still renders opt-in required, never a flash of status", () => {
	assert.ok(selectPresenceImage(snap({ logReadingAllowed: undefined })).endsWith("/optin"));
});

test("each known presence maps to its own tile", () => {
	const cases: Array<[Presence, string]> = [
		["available", "/available"],
		["busy", "/busy"],
		["beRightBack", "/brb"],
		["away", "/away"],
		["offline", "/offline"],
	];
	for (const [value, suffix] of cases) {
		assert.ok(
			selectPresenceImage(snap({ presence: { value, known: true, source: "teams-log" } })).endsWith(suffix),
			`${value} -> ${suffix}`,
		);
	}
});

test("do not disturb wins even in a meeting (matches Teams' own precedence)", () => {
	const s = snap({
		state: { isInMeeting: true },
		presence: { value: "doNotDisturb", known: true, source: "teams-log" },
	});
	assert.ok(selectPresenceImage(s).endsWith("/dnd"));
});

test("in a meeting overrides a non-DND availability", () => {
	const s = snap({
		state: { isInMeeting: true },
		presence: { value: "available", known: true, source: "teams-log" },
	});
	assert.ok(selectPresenceImage(s).endsWith("/inmeeting"));
});

test("teams not running renders unknown", () => {
	const s = snap({ connected: false, presence: { value: "unknown", known: false, source: "teams-log" } });
	assert.ok(selectPresenceImage(s).endsWith("/unknown"));
});

test("opted in but presence not yet seeded renders unknown, never a fake state", () => {
	const s = snap({ presence: { value: "unknown", known: false, source: "teams-log" } });
	assert.ok(selectPresenceImage(s).endsWith("/unknown"));
});
