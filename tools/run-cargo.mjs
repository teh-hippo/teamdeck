import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function configuredToolchain() {
	if (process.env.TEAMDECK_RUST_TOOLCHAIN) {
		return process.env.TEAMDECK_RUST_TOOLCHAIN;
	}
	const config = readFileSync(join(root, "mise.toml"), "utf8");
	return config.match(/^TEAMDECK_RUST_TOOLCHAIN\s*=\s*"([^"]+)"/m)?.[1];
}

const rustToolchain = configuredToolchain();

function resolveCargo() {
	if (rustToolchain) {
		try {
			return execFileSync("rustup", ["which", "cargo", "--toolchain", rustToolchain], { encoding: "utf8" }).trim();
		} catch {
			// Fall through to the active mise or PATH toolchain.
		}
	}
	try {
		return execFileSync("mise", ["which", "cargo"], { encoding: "utf8" }).trim();
	} catch {
		return "cargo";
	}
}

function quote(value) {
	return `"${value.replaceAll('"', '""')}"`;
}

const cargo = resolveCargo();
const args = process.argv.slice(2);
let result;

if (process.platform === "win32") {
	const installer = join(
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		"Microsoft Visual Studio",
		"Installer",
	);
	const vswhere = join(installer, "vswhere.exe");
	if (!existsSync(vswhere)) {
		throw new Error("Visual Studio Build Tools are required to build the native helper.");
	}
	const installation = execFileSync(
		vswhere,
		[
			"-latest",
			"-products",
			"*",
			"-requires",
			"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
			"-property",
			"installationPath",
		],
		{ encoding: "utf8" },
	).trim();
	if (!installation) {
		throw new Error("Visual Studio C++ x64 build tools are required to build the native helper.");
	}
	const vcvars = join(installation, "VC", "Auxiliary", "Build", "vcvarsall.bat");
	const work = mkdtempSync(join(tmpdir(), "teamdeck-cargo-"));
	const script = join(work, "run.cmd");
	writeFileSync(
		script,
		`@set "PATH=${installer};%PATH%"\r\n${rustToolchain ? `@set "RUSTUP_TOOLCHAIN=${rustToolchain}"\r\n` : ""}@call ${quote(vcvars)} x64 >nul\r\n@${quote(cargo)} ${args.map(quote).join(" ")}\r\n@exit /b %ERRORLEVEL%\r\n`,
	);
	try {
		result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", script], { stdio: "inherit" });
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
} else {
	result = spawnSync(cargo, args, { stdio: "inherit" });
}

process.exit(result.status ?? 1);
