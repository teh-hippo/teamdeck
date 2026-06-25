import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";

import streamDeck from "@elgato/streamdeck";

import { HELPER_DISCONNECTED, type HelperSnapshot, mapHelperSnapshot } from "./helper-map";
import { helperPath as defaultHelperPath } from "./helper-path";
import type { Listener, ReactionType, TeamsSnapshot } from "./types";

const MAX_RESTART_DELAY = 30_000;

type HelperMessage = HelperSnapshot & { type?: string; ok?: boolean; cmd?: string };

/** The minimal logger surface the client uses; injectable so unit tests can supply a double. */
type HelperLogger = { info(message: string): void; warn(message: string): void };

/** Dependencies, defaulted to production wiring and overridden in unit tests. */
type HelperDeps = {
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
	#lastLabelIssues = "";
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
		this.#notify(listener, this.#snapshot);
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

	/** Replaces a helper whose stdin broke (failed or unwritable write) before its 'close' landed,
	 * when #proc is still set and recover() would no-op. Kills the dead child and respawns now; its
	 * later 'close' is ignored by #spawn's `#proc !== proc` guard. Inert once stopped. */
	#killAndRespawn(): void {
		if (this.#stopped) {
			return;
		}
		const dead = this.#proc;
		this.#proc = undefined;
		try {
			dead?.kill();
		} catch {
			// ignore
		}
		this.#spawn();
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
			this.#killAndRespawn();
			return;
		}
		try {
			stdin.write(`${JSON.stringify(arg === undefined ? { cmd } : { cmd, arg })}\n`);
		} catch (err) {
			// The process can die between the writable check and the write (EPIPE): the pipe is gone
			// but 'close' has not landed yet, so respawn now instead of dropping the press.
			this.#log.warn(`Teams helper write failed for "${cmd}": ${String(err)}`);
			this.#killAndRespawn();
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
			createInterface({ input: proc.stdout }).on("line", (line) => {
				// Ignore buffered lines from a process we have already replaced (see the exit guard).
				if (this.#proc === proc) {
					this.#onLine(line);
				}
			});
		}
		proc.stderr?.on("data", (chunk) => this.#log.warn(`Teams helper: ${String(chunk).trim()}`));
		proc.stdin?.on("error", (err) => this.#log.warn(`Teams helper stdin error: ${err.message}`));
		proc.on("spawn", () => this.#log.info("Teams UIA helper started."));
		const handleGone = (reason: string): void => {
			if (this.#proc !== proc) {
				return; // a newer process already replaced this one; ignore.
			}
			this.#proc = undefined;
			this.#setSnapshot(HELPER_DISCONNECTED);
			if (!this.#stopped) {
				this.#log.info(`Teams UIA helper ${reason}; restarting.`);
				this.#scheduleRestart();
			}
		};
		proc.on("error", (err) => {
			this.#log.warn(`Teams UIA helper error: ${err.message}`);
			handleGone("failed to start");
		});
		// 'close' always fires once the process is gone (after 'exit', or after 'error' when the
		// helper never started), so recovery cannot stall on a spawn error that emits no 'exit'.
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
		let snapshot: TeamsSnapshot;
		try {
			snapshot = mapHelperSnapshot(msg);
		} catch (err) {
			// A parseable but malformed line (e.g. missing signals) must not crash the plugin.
			this.#log.warn(`Ignoring malformed Teams helper snapshot: ${String(err)}`);
			return;
		}
		// A healthy helper is emitting snapshots, so reset the restart backoff here rather than on
		// 'spawn' (which fires before the helper has proven it can stay up).
		this.#restartDelay = 1_000;
		this.#setSnapshot(snapshot);
		this.#reportLabelIssues(snapshot.labelIssues);
	}

	/** Logs (throttled) when the helper reports a control whose UIA label it could not interpret, so
	 * a Teams wording change or an unsupported display language is visible rather than a silently
	 * greyed-out key. Re-logs only when the set of unrecognised labels changes. */
	#reportLabelIssues(issues: string[] | undefined): void {
		const key = (issues ?? []).join(" | ");
		if (key === this.#lastLabelIssues) {
			return;
		}
		this.#lastLabelIssues = key;
		if (key.length > 0) {
			this.#log.warn(`Teams control label not recognised (state shows unknown): ${key}`);
		}
	}

	#setSnapshot(snapshot: TeamsSnapshot): void {
		this.#snapshot = snapshot;
		for (const listener of this.#listeners) {
			this.#notify(listener, snapshot);
		}
	}

	/** Delivers a snapshot to one listener, isolating a throwing subscriber so it can neither abort
	 * the fan-out nor escape as an uncaught exception that would crash the plugin. */
	#notify(listener: Listener, snapshot: TeamsSnapshot): void {
		try {
			listener(snapshot);
		} catch (err) {
			this.#log.warn(`Teams snapshot listener threw: ${String(err)}`);
		}
	}
}
