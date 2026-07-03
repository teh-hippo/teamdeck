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

/** Writes a pre-built SVG string (for the presence tiles, whose shapes are drawn, not glyph-sourced). */
async function writeRawSvg(rel, size, svg, suffix) {
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

// Presence (Availability) tiles: a solid coloured status disc + a white inner mark, mirroring the
// Teams presence taxonomy but using the TeamDeck palette for coherence. Shapes are drawn here (not
// sourced from a Fluent glyph) except "in a meeting", which reuses the people glyph.
const WHITE = "#F7FAFC";
const PRESENCE_DISC = {
	available: COLORS.on,
	busy: COLORS.off,
	dnd: COLORS.off,
	brb: COLORS.raised,
	away: COLORS.raised,
	offline: "#8A94A6",
	inmeeting: COLORS.off,
	unknown: "#6B7280",
	optin: "#5A6B7B",
};

function presenceKey(inner, size, color, hollow = false) {
	const disc = hollow
		? `<circle cx="36" cy="36" r="18.5" fill="none" stroke="${color}" stroke-width="3.5"/>`
		: `<circle cx="36" cy="36" r="19" fill="${color}"/>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">
  <rect x="5" y="5" width="62" height="62" rx="16" fill="${COLORS.tile}"/>
  <rect x="5.75" y="5.75" width="60.5" height="60.5" rx="15.25" fill="none" stroke="${COLORS.tileStroke}" stroke-width="1.5"/>
  ${disc}
  ${inner}
</svg>`;
}

function presenceListIcon(size) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <circle cx="12" cy="12" r="7" fill="${COLORS.listGlyph}"/>
</svg>`;
}

const peopleInner = await readGlyph("people_24_filled.svg");
const PRESENCE_INNER = {
	available: `<path d="M28 36.5 l5.5 5.5 L45 30" fill="none" stroke="${WHITE}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`,
	busy: "",
	dnd: `<rect x="26.5" y="33.5" width="19" height="5" rx="2.5" fill="${WHITE}"/>`,
	brb: `<circle cx="36" cy="36" r="9" fill="none" stroke="${WHITE}" stroke-width="2.6"/><path d="M36 30.5 V36 l3.6 3.2" fill="none" stroke="${WHITE}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
	away: `<circle cx="36" cy="36" r="9" fill="none" stroke="${WHITE}" stroke-width="2.6"/><path d="M36 30.5 V36 l3.6 3.2" fill="none" stroke="${WHITE}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
	offline: `<path d="M30 30 l12 12 M42 30 l-12 12" stroke="${WHITE}" stroke-width="4" stroke-linecap="round"/>`,
	inmeeting: `<g transform="translate(20 20) scale(1.33)" fill="${WHITE}">${peopleInner}</g>`,
	unknown: `<path d="M31.5 33 a4.6 4.6 0 1 1 6.2 4.3 c-1.7 1 -1.7 2 -1.7 3.2" fill="none" stroke="${WHITE}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="35.9" cy="44.2" r="1.9" fill="${WHITE}"/>`,
	optin: `<rect x="30" y="35.5" width="12" height="9" rx="1.6" fill="${WHITE}"/><path d="M32.4 35.5 v-2.4 a3.6 3.6 0 0 1 7.2 0 v2.4" fill="none" stroke="${WHITE}" stroke-width="2.3"/>`,
};

await writeRawSvg("imgs/actions/availability/icon", 20, presenceListIcon(20), "");
await writeRawSvg("imgs/actions/availability/icon", 40, presenceListIcon(40), "@2x");
for (const name of Object.keys(PRESENCE_INNER)) {
	const rel = `imgs/actions/availability/${name}`;
	const hollow = name === "unknown";
	await writeRawSvg(rel, 72, presenceKey(PRESENCE_INNER[name], 72, PRESENCE_DISC[name], hollow), "");
	await writeRawSvg(rel, 144, presenceKey(PRESENCE_INNER[name], 144, PRESENCE_DISC[name], hollow), "@2x");
	console.log(`wrote ${rel}.png (72) and @2x (144)`);
}

console.log("done");
