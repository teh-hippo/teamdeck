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

function resolveCargo() {
	// Prefer cargo on PATH (CI runners); fall back to the default rustup install location, since on
	// local Windows dev cargo is often absent from a non-interactive PATH.
	const candidates = ["cargo"];
	const home = process.env.USERPROFILE || process.env.HOME;
	if (home) {
		candidates.push(join(home, ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo"));
	}
	for (const candidate of candidates) {
		try {
			execFileSync(candidate, ["--version"], { stdio: "ignore" });
			return candidate;
		} catch {
			// try the next candidate
		}
	}
	throw new Error("cargo not found. Install Rust (https://rustup.rs) to build the native helper.");
}

const cargo = resolveCargo();
console.log(`Building native helper with ${cargo} ...`);
execFileSync(cargo, ["build", "--release"], { cwd: nativeDir, stdio: "inherit" });

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
