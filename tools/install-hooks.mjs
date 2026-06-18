// Installs local git hooks. Run with `npm run hooks` (also wired to postinstall).
// Adds a pre-commit hook that runs the secret scan so a Teams token can never be committed.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

let hooksDir;
try {
	// Ask git for the hooks directory so plain checkouts and linked worktrees (where .git is a
	// file pointing at the shared common dir) both resolve correctly, with no worktree special-casing.
	const raw = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).trim();
	hooksDir = resolve(process.cwd(), raw);
} catch {
	console.log("Not a git repository (or git unavailable); skipping hook install.");
	process.exit(0);
}

mkdirSync(hooksDir, { recursive: true });
const hookPath = join(hooksDir, "pre-commit");
writeFileSync(hookPath, "#!/bin/sh\nnode tools/secret-scan.mjs || exit 1\n");
try {
	chmodSync(hookPath, 0o755);
} catch {
	// chmod is a no-op on Windows; the hook still runs via git's bundled sh.
}
console.log(`Installed pre-commit hook -> ${hookPath}`);
