// Release-candidate proof gate: deterministic plugin and native checks on Windows.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

if (process.platform !== "win32") {
	console.error("x proof requires Windows because the native helper and Stream Deck validation are Windows-specific.");
	process.exit(1);
}

const npm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const steps = [
	["typecheck", "typecheck"],
	["lint", "lint"],
	["build", "build"],
	["validate", "validate"],
	["check-icons", "check-icons"],
	["test", "test"],
	["helper format", "format:helper"],
	["helper lint", "lint:helper"],
	["helper test", "test:helper"],
	["helper dependencies", "machete:helper"],
	["helper build", "build:helper"],
	["helper smoke", "smoke:helper"],
];

for (const [label, script] of steps) {
	process.stdout.write(`\n=== ${label}: npm run ${script} ===\n`);
	const result = spawnSync(process.execPath, [npm, "run", script], { stdio: "inherit" });
	if (result.status !== 0) {
		console.error(`\nx ${label} failed (exit ${result.status ?? "unknown"}). Proof gate not passed.`);
		if (result.error) {
			console.error(result.error);
		}
		process.exit(1);
	}
}

console.log("\nok release-candidate proof gate passed");
