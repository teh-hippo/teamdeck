// Tier A proof gate: the deterministic, fully-autonomous checks that must pass every iteration.
// Runs build + validate, plus the test script when one is defined. Fails closed.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const steps = [
	["build", "npm run build"],
	["validate", "npm run validate"],
	["check-icons", "npm run check-icons"],
];
if (pkg.scripts?.test) {
	steps.push(["test", "npm test"]);
}

for (const [label, cmd] of steps) {
	process.stdout.write(`\n=== ${label}: ${cmd} ===\n`);
	const result = spawnSync(cmd, { stdio: "inherit", shell: true });
	if (result.status !== 0) {
		console.error(`\nx ${label} failed (exit ${result.status}). Proof gate not passed.`);
		process.exit(1);
	}
}

console.log("\nok Tier A proof gate passed");
