import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, mock, test } from "node:test";

import { HelperClient } from "../src/teams/helper.ts";

/** Captures stdin writes and can be told to throw on the next write (simulating EPIPE). */
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

/** A stand-in for the spawned helper child process: real streams, scriptable lifecycle events. */
class FakeProc extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin = new FakeStdin();
	killed = false;

	kill(): boolean {
		this.killed = true;
		return true;
	}

	/** Emits one newline-delimited JSON line on stdout, as the real helper would. */
	line(obj: unknown): void {
		this.stdout.write(`${JSON.stringify(obj)}\n`);
	}

	cleanup(): void {
		this.stdout.destroy();
		this.stderr.destroy();
	}
}

/** Records log calls; methods return `this` to match the Stream Deck logger surface. */
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

const registry: FakeProc[] = [];

function makeClient() {
	const procs: FakeProc[] = [];
	const logger = new FakeLogger();
	const spawn = (() => {
		const proc = new FakeProc();
		procs.push(proc);
		registry.push(proc);
		return proc;
	}) as unknown as typeof import("node:child_process").spawn;
	const client = new HelperClient({ spawn, helperPath: () => "fake-helper.exe", logger });
	return { client, procs, logger };
}

function validSnapshot() {
	return {
		type: "snapshot",
		teamsRunning: true,
		inMeeting: true,
		window: { pid: 1, name: "Meeting | Microsoft Teams" },
		signals: {
			mute: { value: false, available: true, source: "uia-label" },
			camera: { value: true, available: true, source: "uia-label" },
			hand: { value: false, available: true, source: "uia-label" },
			sharing: { value: false, available: true, source: "uia-window" },
		},
	};
}

/** Lets the readline interface deliver any buffered stdout lines. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
	mock.timers.reset();
	for (const proc of registry) {
		proc.cleanup();
	}
	registry.length = 0;
});

test("react sends 'surprised' for wow and passes other reactions through", () => {
	const { client, procs } = makeClient();
	client.start();
	client.react("wow");
	client.react("like");
	assert.deepEqual(procs[0].stdin.writes, ['{"cmd":"react","arg":"surprised"}\n', '{"cmd":"react","arg":"like"}\n']);
});

test("a snapshot line is parsed and published to subscribers", async () => {
	const { client, procs } = makeClient();
	client.start();
	procs[0].line(validSnapshot());
	await flush();
	assert.equal(client.snapshot.connected, true);
	assert.equal(client.snapshot.state.isInMeeting, true);
	assert.equal(client.snapshot.state.isMuted, false);
});

test("a failed result line is logged and leaves the snapshot unchanged", async () => {
	const { client, procs, logger } = makeClient();
	client.start();
	procs[0].line({ type: "result", ok: false, cmd: "toggle-mute" });
	await flush();
	assert.equal(client.snapshot.connected, false);
	assert.ok(logger.warns.some((m) => m.includes("toggle-mute")));
});

test("a malformed snapshot line is ignored rather than crashing", async () => {
	const { client, procs, logger } = makeClient();
	client.start();
	procs[0].stdout.write("not json at all\n");
	procs[0].line({ inMeeting: true }); // valid JSON but no signals: mapping would throw
	await flush();
	assert.equal(client.snapshot.connected, false);
	assert.ok(logger.warns.some((m) => m.toLowerCase().includes("malformed")));
});

test("a throwing subscriber neither aborts the fan-out nor escapes", async () => {
	const { client, procs, logger } = makeClient();
	let secondCalls = 0;
	client.subscribe(() => {
		throw new Error("boom");
	});
	client.subscribe(() => {
		secondCalls++;
	});
	client.start();
	procs[0].line(validSnapshot());
	await flush();
	assert.ok(secondCalls > 0, "the second listener still received snapshots");
	assert.ok(logger.warns.some((m) => m.includes("listener threw")));
});

test("stop kills the helper, is idempotent and prevents any restart", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const { client, procs } = makeClient();
	client.start();
	const proc = procs[0];
	client.stop();
	assert.equal(proc.killed, true);
	assert.equal(client.snapshot.connected, false);
	client.stop(); // second call must be a no-op
	proc.emit("close", 0); // a late close from the killed process must not schedule a restart
	mock.timers.tick(60_000);
	assert.equal(procs.length, 1, "no respawn after stop()");
});

test("sending a command while the helper is down recovers it", () => {
	const { client, procs } = makeClient();
	client.start();
	procs[0].emit("close", 1); // process gone; a restart is scheduled but has not fired yet
	client.toggleMute(); // finds no writable stdin and recovers immediately
	assert.equal(procs.length, 2, "recover() respawned the helper");
});

test("buffered lines from a replaced process are ignored", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const { client, procs } = makeClient();
	client.start();
	const old = procs[0];
	old.emit("close", 1);
	mock.timers.tick(1_000); // restart fires -> procs[1]
	assert.equal(procs.length, 2);
	old.line(validSnapshot()); // a late line from the replaced process
	await flush();
	assert.equal(client.snapshot.connected, false, "the stale line was ignored");
});

test("restart backoff grows on a crash loop and resets after a healthy snapshot", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const { client, procs } = makeClient();
	client.start();

	procs[0].emit("close", 1); // schedules a restart at 1s
	mock.timers.tick(999);
	assert.equal(procs.length, 1, "no respawn before 1s");
	mock.timers.tick(1);
	assert.equal(procs.length, 2, "respawn at 1s");

	procs[1].emit("close", 1); // still no healthy snapshot: backoff has grown to 2s
	mock.timers.tick(1999);
	assert.equal(procs.length, 2, "backoff grew beyond 1s");
	mock.timers.tick(1);
	assert.equal(procs.length, 3, "respawn at 2s");

	procs[2].line(validSnapshot()); // proves health -> backoff resets to 1s
	await flush();
	assert.equal(client.snapshot.connected, true);

	procs[2].emit("close", 1);
	mock.timers.tick(1_000);
	assert.equal(procs.length, 4, "backoff reset to 1s after a healthy snapshot");
});

test("a write EPIPE during the death race respawns immediately instead of deferring to the backoff", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	const { client, procs } = makeClient();
	client.start();
	// stdin broke but 'close' hasn't landed: #proc is still set and the next write throws EPIPE.
	procs[0].stdin.failNext = true;
	client.toggleMute();
	assert.equal(procs.length, 2, "EPIPE on write must tear the dead child down and respawn now");
	procs[0].emit("close", 1); // the replaced child's late close + any stale timer must not spawn a third.
	mock.timers.tick(60_000);
	assert.equal(procs.length, 2, "no double-spawn from the dead child's close or a stale timer");
});

test("an unwritable stdin during the death race respawns immediately", () => {
	const { client, procs } = makeClient();
	client.start();
	procs[0].stdin.writable = false; // pipe gone; the process 'close' has not been processed yet.
	client.toggleMute();
	assert.equal(procs.length, 2, "an unwritable stdin must respawn immediately, not wait for the backoff");
});

test("after stop(), a stray command never respawns the helper", () => {
	const { client, procs } = makeClient();
	client.start();
	client.stop();
	client.toggleMute(); // stdin is gone, but the client is stopped: it must stay down.
	assert.equal(procs.length, 1, "stop() must keep the helper down even if a command races in");
});
