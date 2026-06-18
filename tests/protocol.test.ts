import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { actionable, buildUrl, mergePermissions, mergeState, pairingDecision, parseMessage } from "../src/teams/protocol.ts";
import type { TeamsSnapshot } from "../src/teams/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const progressDir = join(here, "..", "agent", "progress");
const identity = { manufacturer: "TeamDeck", device: "Stream Deck", app: "TeamDeck", appVersion: "0.1.0" };

test("buildUrl omits the token when absent", () => {
	const url = buildUrl(identity);
	assert.ok(!url.includes("token="), "no token param when unpaired");
	assert.ok(url.startsWith("ws://127.0.0.1:8124?"));
	assert.ok(url.includes("protocol-version=2.0.0"));
	assert.ok(url.includes("manufacturer=TeamDeck"));
});

test("buildUrl includes the token when present", () => {
	assert.ok(buildUrl(identity, "abc-123").includes("token=abc-123"));
});

test("parseMessage handles JSON and rejects junk", () => {
	assert.equal(parseMessage("not json"), null);
	assert.deepEqual(parseMessage('{"response":"Success"}'), { response: "Success" });
});

test("mergeState preserves omitted fields and ignores undefined", () => {
	assert.deepEqual(mergeState({ isMuted: true, isInMeeting: true }, { isMuted: false }), {
		isMuted: false,
		isInMeeting: true,
	});
	const prev = { isMuted: true };
	assert.equal(mergeState(prev, undefined), prev);
});

test("pairingDecision maps token and canPair to an action", () => {
	assert.equal(pairingDecision(false, undefined), "none");
	assert.equal(pairingDecision(false, false), "none");
	assert.equal(pairingDecision(false, true), "pair");
	assert.equal(pairingDecision(true, true), "repair");
	assert.equal(pairingDecision(true, false), "none");
});

test("actionable requires connected, in a meeting, and the permission", () => {
	const base: TeamsSnapshot = {
		connected: true,
		paired: true,
		state: { isInMeeting: true },
		permissions: { canToggleMute: true },
	};
	assert.equal(actionable(base, "canToggleMute"), true);
	assert.equal(actionable({ ...base, connected: false }, "canToggleMute"), false);
	assert.equal(actionable({ ...base, state: {} }, "canToggleMute"), false);
	assert.equal(actionable({ ...base, permissions: {} }, "canToggleMute"), false);
});

test("fixture replay reproduces the captured state and permissions", () => {
	const fixture = readdirSync(progressDir)
		.filter((f) => f.startsWith("probe-observe-") && f.endsWith(".json"))
		.map((f) => JSON.parse(readFileSync(join(progressDir, f), "utf8")))
		.find((d) => d.messages.some((m) => m.payload?.meetingUpdate?.meetingState));
	assert.ok(fixture, "a captured fixture with meetingState exists");

	let state = {};
	let permissions = {};
	for (const m of fixture.messages) {
		const update = m.payload?.meetingUpdate;
		if (!update) {
			continue;
		}
		state = mergeState(state, update.meetingState);
		permissions = mergePermissions(permissions, update.meetingPermissions);
	}
	assert.deepEqual(state, fixture.seen.stateFields);
	assert.deepEqual(permissions, fixture.seen.permissionFields);
});
