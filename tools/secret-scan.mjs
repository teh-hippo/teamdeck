// Pre-commit secret scan. Blocks commits that stage a Teams pairing token.
//
// High-signal: flags a token-like UUID that appears right after a token keyword or as a
// token= URL parameter. Redacted forms (<redacted:N>) are always allowed. Install as a
// git pre-commit hook with `npm run hooks`.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Case-insensitive: catches token / teamsToken / tokenRefresh / TEAMS_TOKEN as `:` or `=`
// assignments, quoted or bare, and `?token=` URL params. Redacted forms contain no UUID, so
// they never match.
const SECRET = new RegExp(`(token|teamstoken|tokenrefresh)["'\\s]*[:=]\\s*["']?${UUID}`, "i");

const staged = execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf8" })
	.split("\n")
	.map((s) => s.trim())
	.filter(Boolean);

const findings = [];
for (const file of staged) {
	if (!existsSync(file) || statSync(file).size > 2_000_000) {
		continue;
	}
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	text.split(/\r?\n/).forEach((line, i) => {
		if (SECRET.test(line)) {
			findings.push(`${file}:${i + 1}`);
		}
	});
}

if (findings.length > 0) {
	console.error("x secret-scan: possible Teams token in staged changes:");
	for (const f of findings) {
		console.error(`  ${f}`);
	}
	console.error("Redact the token (e.g. <redacted:N>) or unstage the file.");
	process.exit(1);
}
