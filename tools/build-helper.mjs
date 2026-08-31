// Builds the native UIA helper (Rust) and bundles it next to the plugin so `pack` ships it.
// The binary name is derived from the crate name in native/Cargo.toml (the single source the plugin
// mirrors via src/teams/helper-path.ts). Asserts the bundled exe exists and is non-empty, so a
// release can never silently ship without a working helper.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeDir = join(root, "native");
const binDir = join(root, "io.github.teh-hippo.teamdeck.sdPlugin", "bin");

const cargoToml = readFileSync(join(nativeDir, "Cargo.toml"), "utf8");
const crate = cargoToml.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
if (!crate) {
	throw new Error("Could not read the crate name from native/Cargo.toml");
}
const exeName = crate + (process.platform === "win32" ? ".exe" : "");

console.log("Building native helper...");
execFileSync(process.execPath, [join(root, "tools", "run-cargo.mjs"), "build", "--release"], {
	cwd: nativeDir,
	stdio: "inherit",
});

const built = join(nativeDir, "target", "release", exeName);
if (!existsSync(built)) {
	throw new Error(`Helper build did not produce ${built}`);
}
mkdirSync(binDir, { recursive: true });
const dest = join(binDir, exeName);
copyFileSync(built, dest);
const { size } = statSync(dest);
if (size <= 0) {
	throw new Error(`Bundled helper ${dest} is empty`);
}
console.log(`Bundled helper -> ${dest} (${size} bytes)`);
