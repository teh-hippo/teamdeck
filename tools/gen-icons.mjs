// Generates the TeamDeck Stream Deck PNG icon set from vendored Fluent system SVG glyphs.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdPlugin = join(root, "io.github.teh-hippo.teamdeck.sdPlugin");
const glyphDir = join(root, "tools", "icons", "glyphs");

sharp.cache(false);
sharp.concurrency(1);

const COLORS = {
	listGlyph: "#E8EAED",
	tile: "#15171D",
	tileStroke: "#2E3440",
	on: "#3DDC84",
	off: "#FF5A5F",
	raised: "#F4B740",
	lowered: "#8FA4B8",
	leave: "#FF5A5F",
	like: "#60A5FA",
	love: "#F472B6",
	applause: "#4ADE80",
	laugh: "#FBBF24",
	wow: "#C084FC",
	disabled: "#6B7280",
	sharing: "#2563EB",
	inmeeting: "#2EA043",
	statusOff: "#5A6B7B",
	unavailable: "#3D3D3D",
};

// Action-list glyph colour: reaction icons keep their accent (so each one is distinct); everything
// else (toggles, status tiles, leave, brand) uses a light neutral that reads on the dark Stream
// Deck UI. Previously every glyph used a near-black neutral and was invisible in the action list.
const REACTION_ACCENTS = new Set(["like", "love", "applause", "laugh", "wow"]);
const glyphColor = (colorKey) => (REACTION_ACCENTS.has(colorKey) ? COLORS[colorKey] : COLORS.listGlyph);

// [relative path (no extension), base size, retina size, colour key, glyph file]. Key images are
// 72x144 (a coloured glyph on a dark tile); every other size is an action-list glyph on a
// transparent background, coloured by glyphColor() above.
const ICONS = [
	["imgs/plugin/marketplace", 288, 512, "brand", "video_24_filled.svg"],
	["imgs/plugin/category-icon", 28, 56, "brand", "video_24_filled.svg"],
	["imgs/actions/mute/icon", 20, 40, "neutral", "mic_24_filled.svg"],
	["imgs/actions/mute/on", 72, 144, "on", "mic_24_filled.svg"],
	["imgs/actions/mute/off", 72, 144, "off", "mic_off_24_filled.svg"],
	["imgs/actions/mute/disabled", 72, 144, "disabled", "mic_off_24_regular.svg"],
	["imgs/actions/camera/icon", 20, 40, "neutral", "video_24_filled.svg"],
	["imgs/actions/camera/on", 72, 144, "on", "video_24_filled.svg"],
	["imgs/actions/camera/off", 72, 144, "off", "video_off_24_filled.svg"],
	["imgs/actions/camera/disabled", 72, 144, "disabled", "video_off_24_regular.svg"],
	["imgs/actions/hand/icon", 20, 40, "neutral", "hand_right_24_regular.svg"],
	["imgs/actions/hand/raised", 72, 144, "raised", "hand_right_24_filled.svg"],
	["imgs/actions/hand/lowered", 72, 144, "lowered", "hand_right_24_regular.svg"],
	["imgs/actions/hand/disabled", 72, 144, "disabled", "hand_right_24_regular.svg"],
	["imgs/actions/leave/icon", 20, 40, "leave", "call_end_24_filled.svg"],
	["imgs/actions/leave/enabled", 72, 144, "leave", "call_end_24_filled.svg"],
	["imgs/actions/leave/disabled", 72, 144, "disabled", "call_end_24_regular.svg"],
];

// Read-only status tiles share one regular shape: a neutral action-list glyph plus on/off/
// unavailable key images, coloured by status. Expanded here to avoid a second generator.
const STATUS_TILES = [
	["sharing", "share_screen_start_24_filled.svg"],
	["inmeeting", "people_24_filled.svg"],
];
for (const [tile, glyph] of STATUS_TILES) {
	ICONS.push(
		[`imgs/actions/${tile}/icon`, 20, 40, "neutral", glyph],
		[`imgs/actions/${tile}/on`, 72, 144, tile, glyph],
		[`imgs/actions/${tile}/off`, 72, 144, "statusOff", glyph],
		[`imgs/actions/${tile}/unavailable`, 72, 144, "unavailable", glyph],
	);
}

// Each reaction shares one shape: a coloured action-list glyph, a coloured key image, and a greyed
// disabled key image that reuses the same glyph. The disabled tile is per-reaction (not one shared
// icon) so every reaction stays visually distinct on the device even when it is not actionable.
const REACTION_TILES = [
	["like", "thumb_like_24_filled.svg"],
	["love", "heart_24_filled.svg"],
	["applause", "hand_multiple_24_filled.svg"],
	["laugh", "emoji_laugh_24_filled.svg"],
	["wow", "emoji_surprise_24_filled.svg"],
];
for (const [name, glyph] of REACTION_TILES) {
	ICONS.push(
		[`imgs/actions/react/${name}-icon`, 20, 40, name, glyph],
		[`imgs/actions/react/${name}`, 72, 144, name, glyph],
		[`imgs/actions/react/${name}-disabled`, 72, 144, "disabled", glyph],
	);
}

function glyphTemplate(inner, size, color) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(3 3) scale(0.75)" fill="${color}">${inner}</g>
</svg>`;
}

function keyTemplate(inner, size, color) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">
  <rect x="5" y="5" width="62" height="62" rx="16" fill="${COLORS.tile}"/>
  <rect x="5.75" y="5.75" width="60.5" height="60.5" rx="15.25" fill="none" stroke="${COLORS.tileStroke}" stroke-width="1.5"/>
  <circle cx="36" cy="36" r="22" fill="${color}" opacity="0.14"/>
  <g transform="translate(18 18) scale(1.5)" fill="${color}">${inner}</g>
</svg>`;
}

async function readGlyph(filename) {
	const svg = await readFile(join(glyphDir, filename), "utf8");
	const match = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/i);
	if (!match) {
		throw new Error(`Cannot read glyph content from ${filename}`);
	}
	return match[1];
}

async function renderPng(svg, size) {
	return sharp(Buffer.from(svg))
		.resize(size, size, { fit: "fill" })
		.png({ compressionLevel: 9, palette: false, adaptiveFiltering: false })
		.withMetadata({})
		.toBuffer();
}

async function writeIcon(rel, size, isGlyph, color, glyph, suffix) {
	const inner = await readGlyph(glyph);
	const svg = isGlyph ? glyphTemplate(inner, size, color) : keyTemplate(inner, size, color);
	const out = join(sdPlugin, rel);
	await mkdir(dirname(out), { recursive: true });
	await writeFile(`${out}${suffix}.png`, await renderPng(svg, size));
}

for (const [rel, base, retina, colorKey, glyph] of ICONS) {
	const isGlyph = !(base === 72 && retina === 144);
	const color = isGlyph ? glyphColor(colorKey) : (COLORS[colorKey] ?? COLORS.disabled);
	await writeIcon(rel, base, isGlyph, color, glyph, "");
	await writeIcon(rel, retina, isGlyph, color, glyph, "@2x");
	console.log(`wrote ${rel}.png (${base}) and @2x (${retina})`);
}
console.log("done");
