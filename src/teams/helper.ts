import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";

import streamDeck from "@elgato/streamdeck";

import { HELPER_DISCONNECTED, type HelperSnapshot, mapHelperSnapshot } from "./helper-map";
import { helperPath as defaultHelperPath } from "./helper-path";
import type { Listener, ReactionType, TeamsSnapshot } from "./types";

const MAX_RESTART_DELAY = 30_000;

type HelperMessage = HelperSnapshot & { type?: string; ok?: boolean; cmd?: string };

/** The Stream Deck logger surface the client uses; injectable so unit tests stay quiet. */
type HelperLogger = Pick<typeof streamDeck.logger, "info" | "warn">;

/** Dependencies, defaulted to production wiring and overridden in unit tests. */
export type HelperDeps = {
	spawn?: typeof nodeSpawn;
	helperPath?: () => string | undefined;
	logger?: HelperLogger;
};

/**
 * A Teams source backed by the native UI-Automation helper (built from `native/`, shipped as
 * `bin/teamdeck-helper.exe`). Spawns it in `serve` mode, parses its newline-delimited snapshot
 * stream, and sends control commands on stdin.
 */
export class HelperClient {
	#proc?: ChildProcess;
	#stopped = true;
	#snapshot: TeamsSnapshot = HELPER_DISCONNECTED;
	#restartDelay = 1_000;
	#restartTimer?: ReturnType<typeof setTimeout>;
	readonly #listeners = new Set<Listener>();

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

	/** Whether the helper child process is currently running (surfaced to the property inspector). */
	get running(): boolean {
		return this.#proc !== undefined && !this.#stopped;
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		listener(this.#snapshot);
		return () => this.#listeners.delete(listener);
	}

	/** Starts the helper process. Idempotent. */
	start(): void {
		if (!this.#stopped) {
			return;
		}
		this.#stopped = false;
		// Clear any snapshot from a previous run so a restart never shows a dead helper's stale state.
		this.#snapshot = HELPER_DISCONNECTED;
		this.#spawn();
	}

	/** Stops the helper and prevents restart; call on plugin shutdown. */
	stop(): void {
		if (this.#stopped) {
			return;
		}
		this.#stopped = true;
		clearTimeout(this.#restartTimer);
		const proc = this.#proc;
		this.#proc = undefined;
		try {
			proc?.kill();
		} catch {
			// ignore
		}
		this.#setSnapshot(HELPER_DISCONNECTED);
	}

	recover(): void {
		if (!this.#proc && !this.#stopped) {
			this.#spawn();
		}
	}

	toggleMute(): void {
		this.#send("toggle-mute");
	}

	toggleVideo(): void {
		this.#send("toggle-camera");
	}

	toggleHand(): void {
		this.#send("raise-hand");
	}

	leave(): void {
		this.#send("leave");
	}

	react(type: ReactionType): void {
		// The plugin's wire type "wow" is the helper's "surprised" reaction; others pass through.
		this.#send("react", type === "wow" ? "surprised" : type);
	}

	#send(cmd: string, arg?: string): void {
		const stdin = this.#proc?.stdin;
		if (!stdin?.writable) {
			this.#log.warn(`Teams helper not running; cannot send "${cmd}".`);
			this.recover();
			return;
		}
		try {
			stdin.write(`${JSON.stringify(arg === undefined ? { cmd } : { cmd, arg })}\n`);
		} catch (err) {
			// The process can die between the writable check and the write (EPIPE); recover.
			this.#log.warn(`Teams helper write failed for "${cmd}": ${String(err)}`);
			this.recover();
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

		if (proc.stdout) {
			createInterface({ input: proc.stdout }).on("line", (line) => this.#onLine(line));
		}
		proc.stderr?.on("data", (chunk) => this.#log.warn(`Teams helper: ${String(chunk).trim()}`));
		proc.stdin?.on("error", (err) => this.#log.warn(`Teams helper stdin error: ${err.message}`));
		proc.on("spawn", () => {
			this.#restartDelay = 1_000;
			this.#log.info("Teams UIA helper started.");
		});
		proc.on("error", (err) => this.#log.warn(`Teams UIA helper error: ${err.message}`));
		proc.on("exit", (code) => {
			if (this.#proc !== proc) {
				return; // a newer process already replaced this one; ignore the stale exit.
			}
			this.#proc = undefined;
			this.#setSnapshot(HELPER_DISCONNECTED);
			if (!this.#stopped) {
				this.#log.info(`Teams UIA helper exited (code ${code ?? "?"}); restarting.`);
				this.#scheduleRestart();
			}
		});
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
		if (this.#stopped) {
			return; // ignore buffered lines that arrive after stop().
		}
		let msg: HelperMessage;
		try {
			msg = JSON.parse(line) as HelperMessage;
		} catch {
			return;
		}
		if (msg.type === "result") {
			if (msg.ok === false) {
				this.#log.warn(`Teams helper command "${msg.cmd}" failed.`);
			}
			return;
		}
		this.#setSnapshot(mapHelperSnapshot(msg));
	}

	#setSnapshot(snapshot: TeamsSnapshot): void {
		this.#snapshot = snapshot;
		for (const listener of this.#listeners) {
			listener(snapshot);
		}
	}
}
