// Draws the Hush icons (violet tile with an "h") if any are missing.
// Your local copies are kept as they are; this only fills gaps (e.g. on a fresh server build).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const VIOLET = [139, 124, 255];
const INK = [11, 11, 15];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const S = 3; // supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const p = pixel((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
        r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// "h" glyph in a unit box (scale s around the centre)
function inH(u, v, s) {
  const x = 0.5 + (u - 0.5) / s, y = 0.5 + (v - 0.5) / s;
  const stem = x >= 0.32 && x <= 0.43 && y >= 0.22 && y <= 0.78;
  const leg = x >= 0.57 && x <= 0.68 && y >= 0.52 && y <= 0.78;
  const dx = x - 0.5, dy = y - 0.52;
  const d = Math.hypot(dx, dy);
  const arch = y <= 0.52 && d <= 0.18 && d >= 0.07 && x >= 0.39;
  return stem || leg || arch;
}
function inRounded(u, v, radius) {
  const cx = Math.min(Math.max(u, radius), 1 - radius);
  const cy = Math.min(Math.max(v, radius), 1 - radius);
  return Math.hypot(u - cx, v - cy) <= radius;
}

const tile = (radius, glyph) => (u, v) => {
  if (radius && !inRounded(u, v, radius)) return [0, 0, 0, 0];
  return inH(u, v, glyph) ? [...INK, 1] : [...VIOLET, 1];
};
const glyphOnly = (color) => (u, v) => (inH(u, v, 0.75) ? [...color, 1] : [0, 0, 0, 0]);

const root = path.join(__dirname, '..');
const jobs = [
  ['assets/icon.png', 1024, tile(0, 1.1)],
  ['assets/favicon.png', 64, tile(0.28, 1.1)],
  ['assets/splash-icon.png', 1024, tile(0.31, 1.05)],
  ['assets/android-icon-background.png', 1024, () => [...VIOLET, 1]],
  ['assets/android-icon-foreground.png', 1024, glyphOnly(INK)],
  ['assets/android-icon-monochrome.png', 1024, glyphOnly([255, 255, 255])],
  ['public/icon-192.png', 192, tile(0.3, 1.05)],
  ['public/icon-512.png', 512, tile(0.3, 1.05)],
  ['public/icon-maskable-192.png', 192, tile(0, 0.8)],
  ['public/icon-maskable-512.png', 512, tile(0, 0.8)],
  ['public/apple-touch-icon.png', 180, tile(0, 1.05)],
];
for (const [rel, size, fn] of jobs) {
  const file = path.join(root, rel);
  if (fs.existsSync(file)) continue;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png(size, fn));
  console.log('icon created:', rel);
}
