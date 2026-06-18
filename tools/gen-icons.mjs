// Generates placeholder PNG icons for the teamdeck Stream Deck plugin.
//
// Pure Node (zlib only) so it runs natively on any platform/arch with no native deps.
// Produces solid rounded-square icons in distinct colours per state, which is enough to
// prove live state visually on the keys. Real glyph icons are a Phase 3 task.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdPlugin = join(root, "io.github.teh-hippo.teamdeck.sdPlugin");

const COLORS = {
  brand: "#4B4FBF", // placeholder brand (indigo); finalised in Phase 3
  neutral: "#B0B3FF", // action list icon
  on: "#2EA043", // active / unmuted / camera-on
  off: "#D13438", // muted / camera-off
  disabled: "#5A5A5A", // not in a meeting
};

// CRC32 (PNG chunk checksum).
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Anti-aliased rounded-rect coverage at a pixel centre.
function coverage(x, y, size, radius) {
  const px = x + 0.5;
  const py = y + 0.5;
  const cx = px < radius ? radius : px > size - radius ? size - radius : px;
  const cy = py < radius ? radius : py > size - radius ? size - radius : py;
  const d = Math.hypot(px - cx, py - cy);
  if (d <= radius - 0.5) return 255;
  if (d >= radius + 0.5) return 0;
  return Math.round((radius + 0.5 - d) * 255);
}

function makePng(size, hex) {
  const [r, g, b] = hexToRgb(hex);
  const radius = Math.max(2, size * 0.18);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = coverage(x, y, size, radius);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// [relative path (no extension), base size, retina size, colour key]
const ICONS = [
  ["imgs/plugin/marketplace", 288, 512, "brand"],
  ["imgs/plugin/category-icon", 28, 56, "brand"],
  ["imgs/actions/mute/icon", 20, 40, "neutral"],
  ["imgs/actions/mute/on", 72, 144, "on"],
  ["imgs/actions/mute/off", 72, 144, "off"],
  ["imgs/actions/mute/disabled", 72, 144, "disabled"],
];

for (const [rel, base, retina, colorKey] of ICONS) {
  const hex = COLORS[colorKey];
  const out = join(sdPlugin, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.png`, makePng(base, hex));
  writeFileSync(`${out}@2x.png`, makePng(retina, hex));
  console.log(`wrote ${rel}.png (${base}) and @2x (${retina})`);
}
console.log("done");
