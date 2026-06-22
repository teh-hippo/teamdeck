import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { HELPER_BINARY, helperCandidates } from "../src/teams/helper-path.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("HELPER_BINARY stays in sync with the Rust crate name (no name drift)", () => {
	const cargoToml = readFileSync(join(repoRoot, "native", "Cargo.toml"), "utf8");
	const crate = cargoToml.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
	assert.equal(HELPER_BINARY, `${crate}.exe`, "the plugin's helper name must match the built crate");
});

test("a helper path candidate uses the bundled binary name", () => {
	const names = helperCandidates()
		.filter((p): p is string => typeof p === "string")
		.map((p) => basename(p));
	assert.ok(names.includes(HELPER_BINARY), `expected a candidate named ${HELPER_BINARY}`);
});
