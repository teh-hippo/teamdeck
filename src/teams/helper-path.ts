import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The bundled helper executable name. It is dictated by the Rust crate name in `native/Cargo.toml`
 * (`teamdeck-helper` -> `teamdeck-helper.exe`); `tools/build-helper.mjs` copies that artifact next to
 * the plugin, and `tests/helper-path.test.ts` asserts this constant stays in sync with the crate, so
 * the plugin and the build can never disagree on the name.
 *
 * This module deliberately imports only node built-ins (no `@elgato/streamdeck`) so it can be unit
 * tested in isolation.
 */
export const HELPER_BINARY = "teamdeck-helper.exe";

function pluginRelative(rel: string): string | undefined {
	try {
		return path.resolve(path.dirname(fileURLToPath(import.meta.url)), rel);
	} catch {
		return undefined;
	}
}

/** Ordered candidate locations: env override, the bundled binary, then a local dev cargo build. */
export function helperCandidates(): Array<string | undefined> {
	return [
		process.env.TEAMDECK_HELPER_PATH,
		pluginRelative(HELPER_BINARY),
		pluginRelative(`../../native/target/release/${HELPER_BINARY}`),
		pluginRelative(`../../native/target/debug/${HELPER_BINARY}`),
	];
}

/** Resolves the helper binary: env override, then the bundled `bin/`, then a dev cargo build. */
export function helperPath(): string | undefined {
	return helperCandidates().find((p): p is string => Boolean(p) && existsSync(p as string));
}
