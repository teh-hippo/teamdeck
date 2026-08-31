import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(
	new URL("../io.github.teh-hippo.teamdeck.sdPlugin/bin/teamdeck-helper.exe", import.meta.url),
);
const result = spawnSync(helper, { encoding: "utf8" });
if (result.status !== 0) {
	throw new Error(`helper exited with ${result.status ?? "no status"}: ${result.stderr.trim()}`);
}
const snapshot = JSON.parse(result.stdout.trim());
if (snapshot.schema !== 2 || typeof snapshot.teamsRunning !== "boolean") {
	throw new Error("helper did not emit the expected schema 2 snapshot");
}
console.log(`helper smoke ok: schema=${snapshot.schema} teamsRunning=${snapshot.teamsRunning}`);
