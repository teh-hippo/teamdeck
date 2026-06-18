// Asserts every icon referenced by the manifest or by a static setImage() literal in src exists
// on disk with both its base and @2x PNG. This covers the "disabled"/"unavailable" images that
// are only ever set at runtime via setImage and so are invisible to `streamdeck validate`.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdPlugin = join(root, "io.github.teh-hippo.teamdeck.sdPlugin");

const refs = new Set();
const addRef = (value) => {
	if (typeof value === "string" && value.startsWith("imgs/")) {
		refs.add(value);
	}
};

// 1) Manifest: the plugin/category icons, and every action's icon and state images.
const manifest = JSON.parse(readFileSync(join(sdPlugin, "manifest.json"), "utf8"));
addRef(manifest.Icon);
addRef(manifest.CategoryIcon);
for (const action of manifest.Actions ?? []) {
	addRef(action.Icon);
	for (const state of action.States ?? []) {
		addRef(state.Image);
	}
}

// 2) Source: static "imgs/..." string literals (e.g. the setImage-only disabled images). Skip
// template literals with interpolation, whose concrete paths are covered by the manifest scan.
const literal = /["'`](imgs\/[^"'`]+)["'`]/g;
const walk = (dir) => {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			walk(path);
		} else if (path.endsWith(".ts")) {
			const text = readFileSync(path, "utf8");
			for (const [, ref] of text.matchAll(literal)) {
				if (!ref.includes("${")) {
					addRef(ref);
				}
			}
		}
	}
};
walk(join(root, "src"));

// 3) Every referenced base path must have both <base>.png and <base>@2x.png on disk.
const missing = [];
for (const ref of [...refs].sort()) {
	for (const suffix of [".png", "@2x.png"]) {
		if (!existsSync(join(sdPlugin, ref + suffix))) {
			missing.push(ref + suffix);
		}
	}
}

if (missing.length > 0) {
	console.error(`x check-icons: ${missing.length} referenced icon file(s) missing:`);
	for (const file of missing) {
		console.error(`  - ${file}`);
	}
	process.exit(1);
}
console.log(`ok check-icons: ${refs.size} referenced icon path(s) present with .png and @2x.png`);
