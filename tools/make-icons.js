#!/usr/bin/env node
// Zero-dependency PNG icon generator for Gate Rush (uses only node:zlib).
// Renders the app icon (a glowing "+17" gate on a dusk sky) at 512, 192, 180, 32 px.
// Usage: node tools/make-icons.js
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'icons');

// ---------- minimal PNG encoder ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter type: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- tiny software rasterizer ----------
class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.px = new Float32Array(w * h * 4); }
  blend(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = (y * this.w + x) * 4, p = this.px, ia = 1 - a;
    p[i] = r * a + p[i] * ia;
    p[i + 1] = g * a + p[i + 1] * ia;
    p[i + 2] = b * a + p[i + 2] * ia;
    p[i + 3] = a + p[i + 3] * ia;
  }
  // fn(x,y) -> [r,g,b,a] (0..1) or null; 2x2 supersampled
  fillFn(fn) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let sy = 0; sy < 2; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const c = fn(x + (sx + 0.5) / 2, y + (sy + 0.5) / 2);
            if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]; }
            n++;
          }
        }
        if (a > 0) this.blend(x, y, r / a, g / a, b / a, a / n);
      }
    }
  }
  toRGBA() {
    const out = Buffer.alloc(this.w * this.h * 4);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(this.px[i] * 255)));
    return out;
  }
}
const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// signed distance to a rounded rectangle centered at (cx,cy), half-size (hw,hh), corner radius r
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - hw + r;
  const dy = Math.abs(y - cy) - hh + r;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
}
// Blocky glyphs on a 5x7 grid for "+", "1", "7"
const GLYPHS = {
  plus: ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  one: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  seven: ['11111', '00001', '00010', '00100', '00100', '00100', '00100'],
};
function glyphSDF(x, y, name, gx, gy, cell) {
  const rows = GLYPHS[name];
  let best = 1e9;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 5; c++) {
      if (rows[r][c] === '1') {
        const d = sdRoundRect(x, y, gx + (c + 0.5) * cell, gy + (r + 0.5) * cell, cell * 0.6, cell * 0.6, cell * 0.2);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

function renderIcon(size, { maskable = false } = {}) {
  const cv = new Canvas(size, size);
  const S = size;
  const skyTop = hex('#1b1530'), skyMid = hex('#5a2d5c'), horizon = hex('#f08a3e'), ground = hex('#1e1d24');
  const gateBlue = hex('#2bb1ff'), gateCore = hex('#8fe3ff'), glow = hex('#2bb1ff');

  // background: sky gradient, sun, road, rounded corners (non-maskable only)
  cv.fillFn((x, y) => {
    const t = y / S;
    let c;
    if (t < 0.62) c = t < 0.35 ? mix(skyTop, skyMid, t / 0.35) : mix(skyMid, horizon, (t - 0.35) / 0.27);
    else c = mix(hex('#3a2a2a'), ground, clamp01((t - 0.62) / 0.3));
    const rw = 0.08 + (t - 0.6) * 1.1;
    const inRoad = t > 0.6 && Math.abs(x / S - 0.5) < rw;
    if (inRoad) {
      c = mix(hex('#3b3a42'), hex('#26252b'), clamp01((t - 0.6) / 0.4));
      const lane = Math.abs(x / S - 0.5) < rw * 0.06 && ((t * 18) % 2) < 1.1;
      if (lane) c = hex('#d8c38a');
    }
    const sd = Math.hypot(x / S - 0.5, y / S - 0.6);
    if (sd < 0.16) c = mix(hex('#ffd27a'), c, clamp01((sd - 0.12) / 0.04));
    let a = 1;
    if (!maskable) {
      const d = sdRoundRect(x, y, S / 2, S / 2, S / 2, S / 2, S * 0.22);
      a = clamp01(0.5 - d);
    }
    return [c[0], c[1], c[2], a];
  });

  // gate glow
  const gx = S * 0.5, gy = S * 0.5, ghw = S * 0.3, ghh = S * 0.24;
  cv.fillFn((x, y) => {
    const d = sdRoundRect(x, y, gx, gy, ghw, ghh, S * 0.04);
    if (d > S * 0.16) return null;
    const a = Math.exp(-Math.max(d, 0) / (S * 0.05)) * 0.55;
    return [glow[0], glow[1], glow[2], a];
  });
  // gate panel: translucent blue with a bright rim
  cv.fillFn((x, y) => {
    const d = sdRoundRect(x, y, gx, gy, ghw, ghh, S * 0.04);
    if (d > 1) return null;
    const rim = clamp01(1 - Math.abs(d + S * 0.012) / (S * 0.012));
    const inner = mix(hex('#1565c0'), gateBlue, clamp01(0.5 + (gy - y) / (ghh * 2)));
    const c = mix(inner, gateCore, rim);
    return [c[0], c[1], c[2], clamp01(0.5 - d) * (0.78 + rim * 0.22)];
  });
  // gate posts
  cv.fillFn((x, y) => {
    const d = Math.min(
      sdRoundRect(x, y, gx - ghw, gy, S * 0.025, ghh + S * 0.05, S * 0.012),
      sdRoundRect(x, y, gx + ghw, gy, S * 0.025, ghh + S * 0.05, S * 0.012),
    );
    if (d > 1) return null;
    const c = hex('#e6edf5');
    return [c[0], c[1], c[2], clamp01(0.5 - d)];
  });
  // "+17" text with a soft shadow
  const cell = S * 0.044, gw = cell * 5, gh = cell * 7, gap = cell * 1.1;
  const total = gw * 3 + gap * 2, x0 = gx - total / 2, y0 = gy - gh / 2;
  const chars = ['plus', 'one', 'seven'];
  cv.fillFn((x, y) => {
    let d = 1e9;
    for (let i = 0; i < chars.length; i++) d = Math.min(d, glyphSDF(x - S * 0.012, y - S * 0.014, chars[i], x0 + i * (gw + gap), y0, cell));
    if (d > S * 0.02) return null;
    return [0, 0.1, 0.25, clamp01(1 - d / (S * 0.02)) * 0.6];
  });
  cv.fillFn((x, y) => {
    let d = 1e9;
    for (let i = 0; i < chars.length; i++) d = Math.min(d, glyphSDF(x, y, chars[i], x0 + i * (gw + gap), y0, cell));
    if (d > 1) return null;
    const c = mix(hex('#ffffff'), hex('#dff6ff'), clamp01((y - y0) / gh));
    return [c[0], c[1], c[2], clamp01(0.5 - d)];
  });
  return encodePNG(S, S, cv.toRGBA());
}

fs.mkdirSync(OUT, { recursive: true });
const jobs = [
  ['icon-512.png', 512, {}],
  ['icon-192.png', 192, {}],
  ['apple-touch-icon.png', 180, {}],
  ['favicon-32.png', 32, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['icon-maskable-192.png', 192, { maskable: true }],
];
for (const [name, size, opts] of jobs) {
  const png = renderIcon(size, opts);
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`wrote icons/${name} (${png.length} bytes)`);
}
