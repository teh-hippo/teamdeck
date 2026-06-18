// Installs local git hooks. Run with `npm run hooks` (also wired to postinstall).
// Adds a pre-commit hook that runs the secret scan so a Teams token can never be committed.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const gitDir = join(process.cwd(), ".git");
if (!existsSync(gitDir)) {
	console.log("No .git directory; skipping hook install.");
	process.exit(0);
}

const hooksDir = join(gitDir, "hooks");
mkdirSync(hooksDir, { recursive: true });
const hookPath = join(hooksDir, "pre-commit");
writeFileSync(hookPath, "#!/bin/sh\nnode tools/secret-scan.mjs || exit 1\n");
try {
	chmodSync(hookPath, 0o755);
} catch {
	// chmod is a no-op on Windows; the hook still runs via git's bundled sh.
}
console.log(`Installed pre-commit hook -> ${hookPath}`);
