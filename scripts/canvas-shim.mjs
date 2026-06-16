// Minimal Canvas shim for Node.js texture generation.
// Implements just enough of the Canvas2D API to create ImageData, manipulate
// pixels, and export to PNG via a simple uncompressed PNG encoder.

import { deflateSync } from 'node:zlib';

class ImageData {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

class CanvasContext {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.imageData = null;
  }
  createImageData(w, h) {
    return new ImageData(w, h);
  }
  putImageData(imageData) {
    this.imageData = imageData;
  }
}

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this._ctx = new CanvasContext(width, height);
  }
  getContext() {
    return this._ctx;
  }
  /** Export the pixel data as a PNG Buffer. */
  toBuffer() {
    const img = this._ctx.imageData;
    if (!img) throw new Error('No image data');
    return encodePNG(img.data, img.width, img.height);
  }
}

export function createCanvas(width, height) {
  return new Canvas(width, height);
}

// --- Minimal PNG encoder (unfiltered, zlib-deflated) ---

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePNG(rgba, w, h) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT: each row prefixed with filter byte 0 (None).
  const rowLen = w * 4 + 1;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) {
    raw[y * rowLen] = 0; // filter: None
    rgba.subarray ? raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * rowLen + 1)
      : Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * rowLen + 1);
  }
  const compressed = deflateSync(raw);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
