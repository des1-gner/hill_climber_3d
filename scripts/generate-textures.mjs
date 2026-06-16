// scripts/generate-textures.mjs
//
// Generates small procedural texture PNGs for vegetation and stores them in
// public/textures/. These are 128x128 tileable textures created with pure math
// (no external dependencies beyond Node's built-in APIs).
//
// Textures generated:
//   bark.png   — brown bark pattern with vertical ridges
//   leaf.png   — green leaf with vein pattern and alpha cutout
//   cactus.png — green cactus skin with subtle vertical ribs
//   sand.png   — warm sandy ground (for desert detail if needed)

import { createCanvas } from './canvas-shim.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'textures');
mkdirSync(OUT_DIR, { recursive: true });

const SIZE = 128;

/** Simple value noise from a hash. */
function hash(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function smoothNoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y, octaves = 4) {
  let v = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    v += amp * smoothNoise(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2;
  }
  return v;
}

function clamp(v, min = 0, max = 255) {
  return Math.max(min, Math.min(max, Math.round(v)));
}

// --- Bark texture ---
function generateBark() {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const ridge = Math.sin(y * 0.4 + fbm(x * 0.05, y * 0.02) * 6) * 0.5 + 0.5;
      const noise = fbm(x * 0.08, y * 0.08, 5);
      const v = 0.25 + ridge * 0.35 + noise * 0.2;
      const i = (y * SIZE + x) * 4;
      img.data[i] = clamp(v * 140);     // R (brown)
      img.data[i + 1] = clamp(v * 90);  // G
      img.data[i + 2] = clamp(v * 50);  // B
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// --- Leaf texture (with alpha for individual leaf shape) ---
function generateLeaf() {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  const cx = SIZE / 2, cy = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      // Elliptical leaf shape.
      const dist = dx * dx * 1.2 + dy * dy * 2.5;
      const inside = dist < 0.85;
      // Central vein + secondary veins.
      const vein = Math.abs(dx) < 0.03 ? 0.7 : 1.0;
      const secVein = Math.abs(Math.sin(dy * 12 + dx * 4)) < 0.1 ? 0.85 : 1.0;
      const noise = fbm(x * 0.06, y * 0.06, 3);
      const green = 0.4 + noise * 0.3;
      const i = (y * SIZE + x) * 4;
      if (inside) {
        img.data[i] = clamp(green * 80 * vein * secVein);
        img.data[i + 1] = clamp(green * 200 * vein * secVein);
        img.data[i + 2] = clamp(green * 60 * vein * secVein);
        img.data[i + 3] = 255;
      } else {
        img.data[i] = 0;
        img.data[i + 1] = 0;
        img.data[i + 2] = 0;
        img.data[i + 3] = 0;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// --- Cactus skin ---
function generateCactus() {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Vertical ribs.
      const rib = Math.sin(x * 0.5) * 0.5 + 0.5;
      const noise = fbm(x * 0.04, y * 0.04, 3);
      const v = 0.35 + rib * 0.15 + noise * 0.15;
      const i = (y * SIZE + x) * 4;
      img.data[i] = clamp(v * 80);
      img.data[i + 1] = clamp(v * 180);
      img.data[i + 2] = clamp(v * 60);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function save(canvas, name) {
  const buf = canvas.toBuffer('image/png');
  writeFileSync(resolve(OUT_DIR, name), buf);
  console.log(`  ${name} (${buf.length} bytes)`);
}

// --- Ground/grass texture (tileable green with blade-like pattern) ---
function generateGround() {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const noise = fbm(x * 0.06, y * 0.06, 4);
      // Vertical streaks simulating grass blades.
      const blade = Math.sin(x * 1.2 + noise * 4) * 0.5 + 0.5;
      const v = 0.3 + noise * 0.25 + blade * 0.15;
      const i = (y * SIZE + x) * 4;
      img.data[i] = clamp(v * 80);
      img.data[i + 1] = clamp(v * 170 + 20);
      img.data[i + 2] = clamp(v * 50);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// --- Dirt/rocky ground texture ---
function generateDirt() {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const noise = fbm(x * 0.08, y * 0.08, 5);
      const v = 0.35 + noise * 0.3;
      const i = (y * SIZE + x) * 4;
      img.data[i] = clamp(v * 150);
      img.data[i + 1] = clamp(v * 120);
      img.data[i + 2] = clamp(v * 80);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// --- Snow ground texture ---
function generateSnow() {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const noise = fbm(x * 0.05, y * 0.05, 3);
      const v = 0.85 + noise * 0.12;
      const i = (y * SIZE + x) * 4;
      img.data[i] = clamp(v * 240);
      img.data[i + 1] = clamp(v * 245);
      img.data[i + 2] = clamp(v * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// --- Sand texture ---
function generateSand() {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const noise = fbm(x * 0.1, y * 0.1, 4);
      const v = 0.6 + noise * 0.2;
      const i = (y * SIZE + x) * 4;
      img.data[i] = clamp(v * 220);
      img.data[i + 1] = clamp(v * 190);
      img.data[i + 2] = clamp(v * 120);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

console.log('Generating textures:');
save(generateBark(), 'bark.png');
save(generateLeaf(), 'leaf.png');
save(generateCactus(), 'cactus.png');
save(generateGround(), 'ground_grass.png');
save(generateDirt(), 'ground_dirt.png');
save(generateSnow(), 'ground_snow.png');
save(generateSand(), 'ground_sand.png');
console.log('Done.');
