import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, mock, test } from "node:test";

import { HelperClient } from "../src/teams/helper.ts";

class FakeStdin extends EventEmitter {
	writable = true;
	readonly writes: string[] = [];
	failNext = false;

	write(chunk: string): boolean {
		if (this.failNext) {
			this.failNext = false;
			throw new Error("EPIPE");
		}
		this.writes.push(chunk);
		return true;
	}
}

class FakeProc extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin = new FakeStdin();
	killed = false;

	kill(): boolean {
		this.killed = true;
		return true;
	}

	line(value: unknown): void {
		this.stdout.write(`${JSON.stringify(value)}\n`);
	}

	cleanup(): void {
		this.stdout.destroy();
		this.stderr.destroy();
	}
}

class FakeLogger {
	readonly infos: string[] = [];
	readonly warns: string[] = [];

	info(...data: unknown[]): this {
		this.infos.push(data.map(String).join(" "));
		return this;
	}

	warn(...data: unknown[]): this {
		this.warns.push(data.map(String).join(" "));
		return this;
	}
}

const procsToClean: FakeProc[] = [];
const clientsToStop: HelperClient[] = [];

function makeClient() {
	const procs: FakeProc[] = [];
	const logger = new FakeLogger();
	const spawn = (() => {
		const proc = new FakeProc();
		procs.push(proc);
		procsToClean.push(proc);
		return proc;
	}) as unknown as typeof import("node:child_process").spawn;
	const client = new HelperClient({ spawn, helperPath: () => "fake-helper.exe", logger });
	clientsToStop.push(client);
	return { client, procs, logger };
}

function validSnapshot(overrides: Record<string, unknown> = {}) {
	return {
		type: "snapshot",
		schema: 2,
		ts: 1,
		teamsRunning: true,
		inMeeting: true,
		signals: {
			mute: { value: false, available: true, source: "uia-label" },
			camera: { value: true, available: true, source: "uia-label" },
			hand: { value: false, available: true, source: "uia-label" },
			sharing: { value: false, available: true, source: "uia-window" },
		},
		controls: { leave: true, react: true },
		...overrides,
	};
}

function result(id: number, cmd: string, over: Record<string, unknown> = {}) {
	return {
		type: "result",
		schema: 2,
		ts: 2,
		id,
		cmd,
		ok: true,
		queueMs: 1,
		actionMs: 2,
		confirmMs: 3,
		totalMs: 6,
		retries: 0,
		...over,
	};
}

function started(id: number, cmd: string, queueMs = 0) {
	return { type: "started", schema: 2, ts: 2, id, cmd, queueMs };
}

const heartbeat = { type: "heartbeat", schema: 2, ts: 1 };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
	for (const client of clientsToStop.splice(0)) {
		client.stop();
	}
	for (const proc of procsToClean.splice(0)) {
		proc.cleanup();
	}
	mock.timers.reset();
});

test("a versioned snapshot is parsed and published", async () => {
	const { client, procs } = makeClient();
	client.start();
	procs[0].line(heartbeat);
	procs[0].line(validSnapshot());
	await flush();
	assert.equal(client.snapshot.connected, true);
	assert.equal(client.snapshot.state.isMuted, false);
	assert.equal(client.snapshot.permissions.canReact, true);
});

test("mute sends a desired state and applies the confirmed observation", async () => {
	const { client, procs, logger } = makeClient();
	client.start();
	procs[0].line(validSnapshot());
	await flush();

	const completed = client.toggleMute();
	assert.deepEqual(JSON.parse(procs[0].stdin.writes[0]), { id: 1, cmd: "set-mute", target: true });
	procs[0].line(result(1, "set-mute", { target: true, observed: true, stateSource: "uia-toggle" }));
	await flush();

	assert.equal(await completed, true);
	assert.equal(client.snapshot.state.isMuted, true);
	assert.ok(logger.infos.some((message) => message.includes("totalMs=6")));
});

test("rapid repeated presses coalesce behind the in-flight desired state", async () => {
	const { client, procs } = makeClient();
	client.start();
	procs[0].line(validSnapshot());
	await flush();

	const muted = client.toggleMute();
	const unmuted = client.toggleMute();
	assert.equal(procs[0].stdin.writes.length, 1, "second press waits for the in-flight target");

	procs[0].line(result(1, "set-mute", { target: true, observed: true }));
	await flush();
	assert.deepEqual(JSON.parse(procs[0].stdin.writes[1]), { id: 2, cmd: "set-mute", target: false });
	procs[0].line(result(2, "set-mute", { target: false, observed: false }));
	await flush();

	assert.equal(await muted, true);
	assert.equal(await unmuted, true);
	assert.equal(client.snapshot.state.isMuted, false);
});

test("an odd rapid-toggle burst resolves superseded waiters", async () => {
	const { client, procs } = makeClient();
	client.start();
	procs[0].line(validSnapshot());
	await flush();

	const first = client.toggleMute();
	const superseded = client.toggleMute();
	const final = client.toggleMute();
	procs[0].line(result(1, "set-mute", { target: true, observed: true }));
	await flush();

	assert.equal(await first, true);
	assert.equal(await final, true);
	assert.equal(await superseded, false);
	assert.equal(procs[0].stdin.writes.length, 1);
});

test("a failed confirmed command resolves false and preserves the trusted snapshot", async () => {
	const { client, procs, logger } = makeClient();
	client.start();
	procs[0].line(validSnapshot());
	await flush();

	const completed = client.toggleHand();
	procs[0].line(
		result(1, "set-hand", {
			ok: false,
			target: true,
			observed: false,
			reason: "confirmation-timeout",
		}),
	);
	await flush();

	assert.equal(await completed, false);
	assert.equal(client.snapshot.state.isHandRaised, false);
	assert.ok(logger.warns.some((message) => message.includes("confirmation-timeout")));
});

test("the latest idempotent target is replayed after an EPIPE restart", async () => {
	const { client, procs } = makeClient();
	client.start();
	procs[0].line(validSnapshot());
	await flush();

	procs[0].stdin.failNext = true;
	const completed = client.toggleHand();
	assert.equal(procs.length, 2);
	assert.equal(procs[0].killed, true);

	procs[1].line(heartbeat);
	procs[1].line(validSnapshot());
	await flush();
	assert.deepEqual(JSON.parse(procs[1].stdin.writes[0]), { id: 2, cmd: "set-hand", target: true });
	procs[1].line(result(2, "set-hand", { target: true, observed: true }));
	await flush();
	assert.equal(await completed, true);
});

test("all pending idempotent controls reconcile after restart", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const { client, procs } = makeClient();
	client.start();
	procs[0].line(validSnapshot());
	await flush();

	const mute = client.toggleMute();
	const camera = client.toggleVideo();
	procs[0].emit("close", 1);
	mock.timers.tick(1_000);
	procs[1].line(heartbeat);
	procs[1].line(validSnapshot());
	await flush();

	assert.deepEqual(
		procs[1].stdin.writes.map((write) => JSON.parse(write)),
		[
			{ id: 3, cmd: "set-mute", target: true },
			{ id: 4, cmd: "set-camera", target: false },
		],
	);
	procs[1].line(result(3, "set-mute", { target: true, observed: true }));
	procs[1].line(result(4, "set-camera", { target: false, observed: false }));
	await flush();
	assert.equal(await mute, true);
	assert.equal(await camera, true);
});

test("replay waits through a transiently unresolved replacement snapshot", async () => {
	const { client, procs } = makeClient();
	client.start();
	procs[0].line(validSnapshot());
	await flush();

	procs[0].stdin.failNext = true;
	const completed = client.toggleHand();
	procs[1].line(heartbeat);
	procs[1].line(
		validSnapshot({
			signals: {
				...validSnapshot().signals,
				hand: { value: null, available: true, source: "uia-state-unresolved:toggle=0,aria=0,description=0,label=1" },
			},
		}),
	);
	await flush();
	assert.equal(procs[1].stdin.writes.length, 0);

	procs[1].line(validSnapshot());
	await flush();
	assert.deepEqual(JSON.parse(procs[1].stdin.writes[0]), { id: 2, cmd: "set-hand", target: true });
	procs[1].line(result(2, "set-hand", { target: true, observed: true }));
	await flush();
	assert.equal(await completed, true);
});

test("leave is never replayed after a broken pipe", async () => {
	const { client, procs } = makeClient();
	client.start();
	procs[0].line(validSnapshot());
	await flush();

	procs[0].stdin.failNext = true;
	assert.equal(await client.leave(), false);
	assert.equal(procs.length, 2);
	procs[1].line(heartbeat);
	procs[1].line(validSnapshot());
	await flush();
	assert.equal(procs[1].stdin.writes.length, 0);
});

test("buffered output from a replaced process is ignored", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const { client, procs } = makeClient();
	client.start();
	const old = procs[0];
	old.emit("close", 1);
	mock.timers.tick(1_000);
	assert.equal(procs.length, 2);
	old.line(validSnapshot());
	await flush();
	assert.equal(client.snapshot.connected, false);
});

test("schema mismatch replaces the helper instead of accepting stale data", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const { client, procs, logger } = makeClient();
	client.start();
	procs[0].line(validSnapshot({ schema: 1 }));
	await flush();
	assert.equal(procs.length, 1, "persistent incompatibility uses crash-loop backoff");
	mock.timers.tick(1_000);
	assert.equal(procs.length, 2);
	assert.equal(client.snapshot.connected, false);
	assert.ok(logger.warns.some((message) => message.includes("schema mismatch")));
});

test("a live process with no heartbeats is replaced", () => {
	mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000 });
	const { client, procs, logger } = makeClient();
	client.start();
	mock.timers.tick(3_000);
	assert.equal(procs.length, 2);
	assert.equal(procs[0].killed, true);
	assert.ok(logger.warns.some((message) => message.includes("heartbeat timed out")));
});

test("a timed-out toggle is replayed after the replacement becomes healthy", async () => {
	mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000 });
	const { client, procs } = makeClient();
	client.start();
	procs[0].line(validSnapshot());
	await flush();

	const completed = client.toggleMute();
	procs[0].line(started(1, "set-mute"));
	await flush();
	mock.timers.tick(2_000);
	assert.equal(procs.length, 2);
	procs[1].line(heartbeat);
	procs[1].line(validSnapshot());
	await flush();
	assert.deepEqual(JSON.parse(procs[1].stdin.writes[0]), { id: 2, cmd: "set-mute", target: true });
	procs[1].line(result(2, "set-mute", { target: true, observed: true }));
	await flush();
	assert.equal(await completed, true);
});

test("queued commands have no deadline until native execution starts", async () => {
	mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
	const { client, procs } = makeClient();
	client.start();
	procs[0].line(validSnapshot());
	await flush();

	const completed = client.react("like");
	mock.timers.tick(10_000);
	assert.equal(procs.length, 1);
	procs[0].line(started(1, "react", 10_000));
	procs[0].line(result(1, "react", { queueMs: 10_000 }));
	await flush();
	assert.equal(await completed, true);
});

test("a replay fails within a bounded time when no replacement snapshot arrives", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const { client, procs, logger } = makeClient();
	client.start();
	procs[0].line(validSnapshot());
	await flush();

	procs[0].stdin.failNext = true;
	const completed = client.toggleHand();
	mock.timers.tick(5_000);
	assert.equal(await completed, false);
	assert.ok(logger.warns.some((message) => message.includes("replay") && message.includes("timed out")));
});

test("an unresolved state blocks a state command", async () => {
	const { client, procs, logger } = makeClient();
	client.start();
	procs[0].line(
		validSnapshot({
			signals: {
				...validSnapshot().signals,
				hand: { value: null, available: true, source: "uia-state-unresolved:toggle=0,aria=1,label=1" },
			},
		}),
	);
	await flush();
	assert.equal(await client.toggleHand(), false);
	assert.equal(procs[0].stdin.writes.length, 0);
	assert.ok(logger.warns.some((message) => message.includes("state is unavailable")));
});

test("malformed output is ignored without changing the snapshot", async () => {
	const { client, procs, logger } = makeClient();
	client.start();
	procs[0].stdout.write("not json\n");
	await flush();
	assert.equal(client.snapshot.connected, false);
	assert.ok(logger.warns.some((message) => message.includes("malformed")));
});
