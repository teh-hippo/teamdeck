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
  neutralGlyph: "#242424",
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
};

const GLYPH_BY_PATH = {
  "imgs/plugin/marketplace": "video_24_filled.svg",
  "imgs/plugin/category-icon": "video_24_filled.svg",
  "imgs/actions/mute/icon": "mic_24_filled.svg",
  "imgs/actions/mute/on": "mic_24_filled.svg",
  "imgs/actions/mute/off": "mic_off_24_filled.svg",
  "imgs/actions/mute/disabled": "mic_off_24_regular.svg",
  "imgs/actions/camera/icon": "video_24_filled.svg",
  "imgs/actions/camera/on": "video_24_filled.svg",
  "imgs/actions/camera/off": "video_off_24_filled.svg",
  "imgs/actions/camera/disabled": "video_off_24_regular.svg",
  "imgs/actions/hand/icon": "hand_right_24_regular.svg",
  "imgs/actions/hand/raised": "hand_right_24_filled.svg",
  "imgs/actions/hand/lowered": "hand_right_24_regular.svg",
  "imgs/actions/hand/disabled": "hand_right_24_regular.svg",
  "imgs/actions/blur/icon": "video_background_effect_24_filled.svg",
  "imgs/actions/blur/on": "video_background_effect_24_filled.svg",
  "imgs/actions/blur/off": "video_background_effect_24_regular.svg",
  "imgs/actions/blur/disabled": "video_background_effect_24_regular.svg",
  "imgs/actions/leave/icon": "call_end_24_filled.svg",
  "imgs/actions/leave/enabled": "call_end_24_filled.svg",
  "imgs/actions/leave/disabled": "call_end_24_regular.svg",
  "imgs/actions/react/like-icon": "thumb_like_24_filled.svg",
  "imgs/actions/react/like": "thumb_like_24_filled.svg",
  "imgs/actions/react/love-icon": "heart_24_filled.svg",
  "imgs/actions/react/love": "heart_24_filled.svg",
  "imgs/actions/react/applause-icon": "hand_multiple_24_filled.svg",
  "imgs/actions/react/applause": "hand_multiple_24_filled.svg",
  "imgs/actions/react/laugh-icon": "emoji_laugh_24_filled.svg",
  "imgs/actions/react/laugh": "emoji_laugh_24_filled.svg",
  "imgs/actions/react/wow-icon": "emoji_surprise_24_filled.svg",
  "imgs/actions/react/wow": "emoji_surprise_24_filled.svg",
  "imgs/actions/react/disabled": "thumb_like_24_filled.svg",
};

// [relative path (no extension), base size, retina size, colour key]
const ICONS = [
  ["imgs/plugin/marketplace", 288, 512, "brand"],
  ["imgs/plugin/category-icon", 28, 56, "brand"],
  ["imgs/actions/mute/icon", 20, 40, "neutral"],
  ["imgs/actions/mute/on", 72, 144, "on"],
  ["imgs/actions/mute/off", 72, 144, "off"],
  ["imgs/actions/mute/disabled", 72, 144, "disabled"],
  ["imgs/actions/camera/icon", 20, 40, "neutral"],
  ["imgs/actions/camera/on", 72, 144, "on"],
  ["imgs/actions/camera/off", 72, 144, "off"],
  ["imgs/actions/camera/disabled", 72, 144, "disabled"],
  ["imgs/actions/hand/icon", 20, 40, "neutral"],
  ["imgs/actions/hand/raised", 72, 144, "raised"],
  ["imgs/actions/hand/lowered", 72, 144, "lowered"],
  ["imgs/actions/hand/disabled", 72, 144, "disabled"],
  ["imgs/actions/blur/icon", 20, 40, "neutral"],
  ["imgs/actions/blur/on", 72, 144, "on"],
  ["imgs/actions/blur/off", 72, 144, "off"],
  ["imgs/actions/blur/disabled", 72, 144, "disabled"],
  ["imgs/actions/leave/icon", 20, 40, "leave"],
  ["imgs/actions/leave/enabled", 72, 144, "leave"],
  ["imgs/actions/leave/disabled", 72, 144, "disabled"],
  ["imgs/actions/react/like-icon", 20, 40, "like"],
  ["imgs/actions/react/like", 72, 144, "like"],
  ["imgs/actions/react/love-icon", 20, 40, "love"],
  ["imgs/actions/react/love", 72, 144, "love"],
  ["imgs/actions/react/applause-icon", 20, 40, "applause"],
  ["imgs/actions/react/applause", 72, 144, "applause"],
  ["imgs/actions/react/laugh-icon", 20, 40, "laugh"],
  ["imgs/actions/react/laugh", 72, 144, "laugh"],
  ["imgs/actions/react/wow-icon", 20, 40, "wow"],
  ["imgs/actions/react/wow", 72, 144, "wow"],
  ["imgs/actions/react/disabled", 72, 144, "disabled"],
];

function glyphTemplate(inner, size) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(3 3) scale(0.75)" fill="${COLORS.neutralGlyph}">${inner}</g>
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

function iconColor(colorKey, isGlyph) {
  if (isGlyph) {
    return COLORS.neutralGlyph;
  }
  return COLORS[colorKey] ?? COLORS.disabled;
}

function isKeyIcon(base, retina) {
  return base === 72 && retina === 144;
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

async function writeIcon(rel, size, colorKey, suffix) {
  const glyphName = GLYPH_BY_PATH[rel];
  if (!glyphName) {
    throw new Error(`No glyph mapped for ${rel}`);
  }
  const isGlyph = !isKeyIcon(...ICONS.find(([iconRel]) => iconRel === rel).slice(1, 3));
  const inner = await readGlyph(glyphName);
  const color = iconColor(colorKey, isGlyph);
  const svg = isGlyph ? glyphTemplate(inner, size) : keyTemplate(inner, size, color);
  const out = join(sdPlugin, rel);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(`${out}${suffix}.png`, await renderPng(svg, size));
}

for (const [rel, base, retina, colorKey] of ICONS) {
  await writeIcon(rel, base, colorKey, "");
  await writeIcon(rel, retina, colorKey, "@2x");
  console.log(`wrote ${rel}.png (${base}) and @2x (${retina})`);
}
console.log("done");
