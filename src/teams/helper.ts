import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";

import streamDeck from "@elgato/streamdeck";

import {
	HELPER_DISCONNECTED,
	HELPER_SCHEMA,
	type HelperSignal,
	type HelperSnapshot,
	mapHelperSnapshot,
} from "./helper-map";
import { helperPath as defaultHelperPath } from "./helper-path";
import type { Listener, ReactionType, TeamsSnapshot, ToggleStateField } from "./types";

const MAX_RESTART_DELAY = 30_000;
const HEARTBEAT_TIMEOUT = 1_800;
const WATCHDOG_INTERVAL = 250;

type HelperLogger = { info(message: string): void; warn(message: string): void };

type HelperDeps = {
	spawn?: typeof nodeSpawn;
	helperPath?: () => string | undefined;
	logger?: HelperLogger;
};

type ToggleCommand = "set-mute" | "set-camera" | "set-hand";
type WireCommand = { id: number; cmd: string; target?: boolean; arg?: string };

type HelperResult = {
	type: "result";
	schema: number;
	ts: number;
	id: number;
	cmd: string;
	ok: boolean;
	target?: boolean;
	observed?: boolean;
	stateSource?: string;
	reason?: string;
	queueMs: number;
	actionMs: number;
	confirmMs: number;
	totalMs: number;
	retries: number;
};

type HelperStarted = {
	type: "started";
	schema: number;
	ts: number;
	id: number;
	cmd: string;
	queueMs: number;
};

type ToggleWaiter = { target: boolean; resolve(ok: boolean): void };
type ToggleEntry = { desired: boolean; inFlight?: number; waiters: ToggleWaiter[] };
type Pending =
	| { kind: "toggle"; wire: WireCommand; control: ToggleCommand; timer?: ReturnType<typeof setTimeout> }
	| { kind: "command"; wire: WireCommand; resolve(ok: boolean): void; timer?: ReturnType<typeof setTimeout> };

const TOGGLE_FIELDS: Record<ToggleCommand, ToggleStateField> = {
	"set-mute": "isMuted",
	"set-camera": "isVideoOn",
	"set-hand": "isHandRaised",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSignal(value: unknown): value is HelperSignal {
	return (
		isRecord(value) &&
		(value.value === null || typeof value.value === "boolean") &&
		typeof value.available === "boolean" &&
		typeof value.source === "string"
	);
}

function isSnapshot(value: unknown): value is HelperSnapshot {
	if (
		!isRecord(value) ||
		value.type !== "snapshot" ||
		typeof value.schema !== "number" ||
		typeof value.ts !== "number"
	) {
		return false;
	}
	const signals = value.signals;
	const controls = value.controls;
	return (
		typeof value.teamsRunning === "boolean" &&
		typeof value.inMeeting === "boolean" &&
		isRecord(signals) &&
		isSignal(signals.mute) &&
		isSignal(signals.camera) &&
		isSignal(signals.hand) &&
		isSignal(signals.sharing) &&
		isRecord(controls) &&
		typeof controls.leave === "boolean" &&
		typeof controls.react === "boolean"
	);
}

function isResult(value: unknown): value is HelperResult {
	return (
		isRecord(value) &&
		value.type === "result" &&
		typeof value.schema === "number" &&
		typeof value.ts === "number" &&
		typeof value.id === "number" &&
		typeof value.cmd === "string" &&
		typeof value.ok === "boolean" &&
		typeof value.queueMs === "number" &&
		typeof value.actionMs === "number" &&
		typeof value.confirmMs === "number" &&
		typeof value.totalMs === "number" &&
		typeof value.retries === "number"
	);
}

function isStarted(value: unknown): value is HelperStarted {
	return (
		isRecord(value) &&
		value.type === "started" &&
		typeof value.schema === "number" &&
		typeof value.ts === "number" &&
		typeof value.id === "number" &&
		typeof value.cmd === "string" &&
		typeof value.queueMs === "number"
	);
}

export class HelperClient {
	#proc?: ChildProcess;
	#stopped = true;
	#snapshot: TeamsSnapshot = HELPER_DISCONNECTED;
	#restartDelay = 1_000;
	#restartTimer?: ReturnType<typeof setTimeout>;
	#watchdogTimer?: ReturnType<typeof setInterval>;
	#lastHeartbeatAt = 0;
	#heartbeatSeen = false;
	#snapshotSeen = false;
	#nextCommandId = 1;
	#lastCompatibilityIssues = "";
	#logReadingEnabled = false;
	readonly #replayControls = new Set<ToggleCommand>();
	readonly #replayTimers = new Map<ToggleCommand, ReturnType<typeof setTimeout>>();
	readonly #listeners = new Set<Listener>();
	readonly #pending = new Map<number, Pending>();
	readonly #toggles = new Map<ToggleCommand, ToggleEntry>();

	readonly #spawnFn: typeof nodeSpawn;
	readonly #helperPath: () => string | undefined;
	readonly #log: HelperLogger;

	constructor(deps: HelperDeps = {}) {
		this.#spawnFn = deps.spawn ?? nodeSpawn;
		this.#helperPath = deps.helperPath ?? defaultHelperPath;
		this.#log = deps.logger ?? streamDeck.logger;
	}

	get snapshot(): TeamsSnapshot {
		return this.#snapshot;
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		this.#notify(listener, this.#snapshot);
		return () => this.#listeners.delete(listener);
	}

	start(): void {
		if (!this.#stopped) {
			return;
		}
		this.#stopped = false;
		this.#snapshot = { ...HELPER_DISCONNECTED, logReadingAllowed: this.#logReadingEnabled };
		this.#watchdogTimer = setInterval(() => this.#watchdog(), WATCHDOG_INTERVAL);
		this.#watchdogTimer.unref?.();
		this.#spawn();
	}

	stop(): void {
		if (this.#stopped) {
			return;
		}
		this.#stopped = true;
		clearTimeout(this.#restartTimer);
		for (const timer of this.#replayTimers.values()) {
			clearTimeout(timer);
		}
		this.#replayTimers.clear();
		clearInterval(this.#watchdogTimer);
		this.#failAllPending();
		const proc = this.#proc;
		this.#proc = undefined;
		try {
			proc?.kill();
		} catch {}
		this.#setSnapshot(HELPER_DISCONNECTED);
	}

	recover(): void {
		if (!this.#proc && !this.#stopped) {
			this.#spawn();
		}
	}

	toggleMute(): Promise<boolean> {
		return this.#toggle("set-mute");
	}

	toggleVideo(): Promise<boolean> {
		return this.#toggle("set-camera");
	}

	toggleHand(): Promise<boolean> {
		return this.#toggle("set-hand");
	}

	leave(): Promise<boolean> {
		return this.#command("leave");
	}

	react(type: ReactionType): Promise<boolean> {
		return this.#command("react", type === "wow" ? "surprised" : type);
	}

	setLogReadingEnabled(on: boolean): void {
		this.#logReadingEnabled = on;
		this.#sendControl("set-log-reading", on ? "on" : "off");
		this.#setSnapshot(this.#snapshot);
	}

	#toggle(control: ToggleCommand): Promise<boolean> {
		const field = TOGGLE_FIELDS[control];
		const existing = this.#toggles.get(control);
		const current = existing?.desired ?? this.#snapshot.state[field];
		if (typeof current !== "boolean") {
			this.#log.warn(`Teams command "${control}" blocked because its state is unavailable.`);
			return Promise.resolve(false);
		}
		const target = !current;
		const entry = existing ?? { desired: target, waiters: [] };
		entry.desired = target;
		this.#toggles.set(control, entry);
		const promise = new Promise<boolean>((resolve) => entry.waiters.push({ target, resolve }));
		if (entry.inFlight === undefined) {
			this.#sendToggle(control);
		}
		return promise;
	}

	#sendToggle(control: ToggleCommand): void {
		const entry = this.#toggles.get(control);
		if (!entry || entry.inFlight !== undefined) {
			return;
		}
		const wire = { id: this.#nextCommandId++, cmd: control, target: entry.desired };
		entry.inFlight = wire.id;
		this.#pending.set(wire.id, { kind: "toggle", wire, control });
		if (!this.#write(wire)) {
			this.#killAndRespawn(`could not send command ${wire.id}`);
		}
	}

	#command(cmd: string, arg?: string): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const wire: WireCommand = { id: this.#nextCommandId++, cmd, ...(arg === undefined ? {} : { arg }) };
			this.#pending.set(wire.id, { kind: "command", wire, resolve });
			if (!this.#write(wire)) {
				this.#killAndRespawn(`could not send command ${wire.id}`);
			}
		});
	}

	#write(wire: WireCommand): boolean {
		const stdin = this.#proc?.stdin;
		if (!stdin?.writable) {
			return false;
		}
		try {
			stdin.write(`${JSON.stringify(wire)}\n`);
			return true;
		} catch (error) {
			this.#log.warn(`Teams helper write failed for command ${wire.id}: ${String(error)}`);
			return false;
		}
	}

	#sendControl(cmd: string, arg: string): void {
		const stdin = this.#proc?.stdin;
		if (!stdin?.writable) {
			return;
		}
		try {
			stdin.write(`${JSON.stringify({ cmd, arg })}\n`);
		} catch (error) {
			this.#log.warn(`Teams helper control "${cmd}" failed: ${String(error)}`);
		}
	}

	#commandTimedOut(id: number): void {
		if (!this.#pending.has(id)) {
			return;
		}
		this.#log.warn(`Teams helper command ${id} timed out.`);
		this.#killAndRespawn(`command ${id} timed out`);
	}

	#watchdog(): void {
		if (this.#stopped || !this.#proc || this.#lastHeartbeatAt === 0) {
			return;
		}
		if (Date.now() - this.#lastHeartbeatAt > HEARTBEAT_TIMEOUT) {
			this.#log.warn("Teams helper heartbeat timed out.");
			this.#killAndRespawn("heartbeat timed out");
		}
	}

	#prepareRestart(): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			if (pending.kind === "toggle") {
				const entry = this.#toggles.get(pending.control);
				if (entry) {
					entry.inFlight = undefined;
					for (const waiter of entry.waiters.splice(0)) {
						if (waiter.target === entry.desired) {
							entry.waiters.push(waiter);
						} else {
							waiter.resolve(false);
						}
					}
					this.#armReplay(pending.control);
				}
			} else {
				pending.resolve(false);
			}
		}
		this.#pending.clear();
	}

	#failToggle(control: ToggleCommand): void {
		const entry = this.#toggles.get(control);
		if (!entry) {
			return;
		}
		for (const waiter of entry.waiters) {
			waiter.resolve(false);
		}
		this.#toggles.delete(control);
		this.#replayControls.delete(control);
		clearTimeout(this.#replayTimers.get(control));
		this.#replayTimers.delete(control);
	}

	#failAllPending(): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			if (pending.kind === "command") {
				pending.resolve(false);
			}
		}
		this.#pending.clear();
		for (const control of this.#toggles.keys()) {
			this.#failToggle(control);
		}
		for (const timer of this.#replayTimers.values()) {
			clearTimeout(timer);
		}
		this.#replayTimers.clear();
		this.#replayControls.clear();
	}

	#armReplay(control: ToggleCommand): void {
		this.#replayControls.add(control);
		clearTimeout(this.#replayTimers.get(control));
		this.#replayTimers.set(
			control,
			setTimeout(() => {
				if (this.#replayControls.has(control)) {
					this.#log.warn(`Teams command replay for ${control} timed out.`);
					this.#failToggle(control);
				}
			}, 5_000),
		);
	}

	#killAndRespawn(reason: string, immediate = true): void {
		if (this.#stopped) {
			return;
		}
		const dead = this.#proc;
		this.#proc = undefined;
		this.#prepareRestart();
		try {
			dead?.kill();
		} catch {}
		this.#setSnapshot(HELPER_DISCONNECTED);
		this.#log.info(`Teams UIA helper ${reason}; restarting.`);
		if (immediate) {
			this.#spawn();
		} else {
			this.#scheduleRestart();
		}
	}

	#spawn(): void {
		const exe = this.#helperPath();
		if (!exe) {
			this.#log.warn("Teams UIA helper binary not found; helper source unavailable.");
			return;
		}
		clearTimeout(this.#restartTimer);
		const proc = this.#spawnFn(exe, ["serve"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		this.#proc = proc;
		this.#lastHeartbeatAt = Date.now();
		this.#heartbeatSeen = false;
		this.#snapshotSeen = false;

		if (proc.stdout) {
			createInterface({ input: proc.stdout }).on("line", (line) => {
				if (this.#proc === proc) {
					this.#onLine(line);
				}
			});
		}
		proc.stderr?.on("data", (chunk) => this.#log.warn(`Teams helper: ${String(chunk).trim()}`));
		proc.stdin?.on("error", (error) => {
			if (this.#proc === proc) {
				this.#log.warn(`Teams helper stdin error: ${error.message}`);
				this.#killAndRespawn("stdin failed");
			}
		});
		proc.on("spawn", () => {
			this.#log.info("Teams UIA helper started.");
			this.#sendControl("set-log-reading", this.#logReadingEnabled ? "on" : "off");
		});
		const handleGone = (reason: string): void => {
			if (this.#proc !== proc) {
				return;
			}
			this.#proc = undefined;
			this.#prepareRestart();
			this.#setSnapshot(HELPER_DISCONNECTED);
			if (!this.#stopped) {
				this.#log.info(`Teams UIA helper ${reason}; restarting.`);
				this.#scheduleRestart();
			}
		};
		proc.on("error", (error) => {
			this.#log.warn(`Teams UIA helper error: ${error.message}`);
			handleGone("failed to start");
		});
		proc.on("close", (code) => handleGone(`exited (code ${code ?? "?"})`));
	}

	#scheduleRestart(): void {
		clearTimeout(this.#restartTimer);
		this.#restartTimer = setTimeout(() => {
			if (!this.#stopped) {
				this.#spawn();
			}
		}, this.#restartDelay);
		this.#restartDelay = Math.min(this.#restartDelay * 2, MAX_RESTART_DELAY);
	}

	#onLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.#log.warn("Ignoring malformed Teams helper output.");
			return;
		}
		if (!isRecord(message) || message.schema !== HELPER_SCHEMA) {
			this.#log.warn(`Teams helper schema mismatch: expected ${HELPER_SCHEMA}.`);
			this.#killAndRespawn("schema mismatch", false);
			return;
		}
		this.#lastHeartbeatAt = Date.now();
		if (message.type === "heartbeat") {
			this.#heartbeatSeen = true;
			this.#markHealthy();
			return;
		}
		if (isResult(message)) {
			this.#handleResult(message);
			return;
		}
		if (isStarted(message)) {
			this.#handleStarted(message);
			return;
		}
		if (!isSnapshot(message)) {
			this.#log.warn("Ignoring malformed Teams helper message.");
			return;
		}
		let snapshot: TeamsSnapshot;
		try {
			snapshot = mapHelperSnapshot(message);
		} catch (error) {
			this.#log.warn(`Ignoring malformed Teams helper snapshot: ${String(error)}`);
			return;
		}
		this.#snapshotSeen = true;
		this.#setSnapshot(snapshot);
		this.#reportCompatibilityIssues(snapshot.compatibilityIssues);
		this.#markHealthy();
		this.#resumeReplay();
	}

	#markHealthy(): void {
		if (this.#heartbeatSeen && this.#snapshotSeen) {
			this.#restartDelay = 1_000;
		}
	}

	#resumeReplay(): void {
		for (const control of [...this.#replayControls]) {
			const entry = this.#toggles.get(control);
			if (!entry) {
				this.#replayControls.delete(control);
				clearTimeout(this.#replayTimers.get(control));
				this.#replayTimers.delete(control);
				continue;
			}
			const observed = this.#snapshot.state[TOGGLE_FIELDS[control]];
			if (typeof observed !== "boolean") {
				continue;
			}
			this.#replayControls.delete(control);
			clearTimeout(this.#replayTimers.get(control));
			this.#replayTimers.delete(control);
			if (observed === entry.desired) {
				for (const waiter of entry.waiters) {
					waiter.resolve(waiter.target === observed);
				}
				this.#toggles.delete(control);
				continue;
			}
			this.#log.info(`Teams command replaying ${control} after helper restart.`);
			this.#sendToggle(control);
		}
	}

	#handleStarted(started: HelperStarted): void {
		const pending = this.#pending.get(started.id);
		if (!pending || pending.wire.cmd !== started.cmd || pending.timer !== undefined) {
			return;
		}
		const deadline =
			started.cmd === "react" || started.cmd === "leave" ? 3_000 : started.cmd === "set-hand" ? 2_500 : 2_000;
		pending.timer = setTimeout(() => this.#commandTimedOut(started.id), deadline);
	}

	#handleResult(result: HelperResult): void {
		const pending = this.#pending.get(result.id);
		if (!pending) {
			return;
		}
		this.#pending.delete(result.id);
		clearTimeout(pending.timer);
		const level = result.ok ? "info" : "warn";
		this.#log[level](
			`Teams command id=${result.id} cmd=${result.cmd} ok=${result.ok} queueMs=${result.queueMs} actionMs=${result.actionMs} confirmMs=${result.confirmMs} totalMs=${result.totalMs} retries=${result.retries}${result.reason ? ` reason=${result.reason}` : ""}`,
		);
		if (pending.kind === "command") {
			pending.resolve(result.ok);
			if (result.ok && result.cmd === "leave") {
				this.#setSnapshot({
					...this.#snapshot,
					state: { ...this.#snapshot.state, isInMeeting: false },
					permissions: {},
				});
			}
			return;
		}
		const entry = this.#toggles.get(pending.control);
		if (!entry || entry.inFlight !== result.id) {
			return;
		}
		entry.inFlight = undefined;
		if (!result.ok || result.observed !== result.target) {
			this.#failToggle(pending.control);
			return;
		}
		const field = TOGGLE_FIELDS[pending.control];
		this.#setSnapshot({
			...this.#snapshot,
			state: { ...this.#snapshot.state, [field]: result.observed },
			availability: { ...this.#snapshot.availability, [field]: true },
		});
		for (const waiter of entry.waiters.splice(0)) {
			if (waiter.target === result.target) {
				waiter.resolve(true);
			} else {
				entry.waiters.push(waiter);
			}
		}
		if (entry.desired !== result.target) {
			this.#sendToggle(pending.control);
		} else {
			for (const waiter of entry.waiters) {
				waiter.resolve(false);
			}
			this.#toggles.delete(pending.control);
		}
	}

	#reportCompatibilityIssues(issues: string[] | undefined): void {
		const key = (issues ?? []).join(" | ");
		if (key === this.#lastCompatibilityIssues) {
			return;
		}
		this.#lastCompatibilityIssues = key;
		if (key.length > 0) {
			this.#log.warn(`Teams control compatibility issue: ${key}`);
		}
	}

	#setSnapshot(snapshot: TeamsSnapshot): void {
		this.#snapshot = { ...snapshot, logReadingAllowed: this.#logReadingEnabled };
		for (const listener of this.#listeners) {
			this.#notify(listener, this.#snapshot);
		}
	}

	#notify(listener: Listener, snapshot: TeamsSnapshot): void {
		try {
			listener(snapshot);
		} catch (error) {
			this.#log.warn(`Teams snapshot listener threw: ${String(error)}`);
		}
	}
}
