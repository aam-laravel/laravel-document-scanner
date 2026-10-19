import { deflateSync, crc32 } from 'node:zlib';

/**
 * Minimal raster + PNG encoder used by the simulator (no native deps), and a
 * header sniffer used to report real page dimensions for any adapter.
 */
export class Raster {
  constructor(width, height, channels) {
    this.width = width;
    this.height = height;
    this.channels = channels; // 1 (gray) or 3 (rgb)
    this.data = new Uint8Array(width * height * channels).fill(255);
  }

  fillRect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    const c = this.channels === 1 ? [toGray(color)] : color;
    for (let yy = y0; yy < y1; yy++) {
      let off = (yy * this.width + x0) * this.channels;
      for (let xx = x0; xx < x1; xx++) {
        for (let k = 0; k < this.channels; k++) this.data[off++] = c[k];
      }
    }
  }

  /** Apply brightness/contrast in [-100, 100] and optional 1-bit threshold. */
  adjust({ brightness = 0, contrast = 0, threshold = null } = {}) {
    const f = (259 * (contrast * 2.55 + 255)) / (255 * (259 - contrast * 2.55));
    const b = brightness * 2.55;
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      let v = f * (i - 128) + 128 + b;
      if (threshold !== null) v = v >= threshold ? 255 : 0;
      lut[i] = Math.max(0, Math.min(255, Math.round(v)));
    }
    for (let i = 0; i < this.data.length; i++) this.data[i] = lut[this.data[i]];
  }

  toPng() {
    const colorType = this.channels === 1 ? 0 : 2;
    const stride = this.width * this.channels;
    const raw = Buffer.alloc((stride + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * (stride + 1)] = 0; // filter: none
      raw.set(this.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

function toGray([r, g, b]) {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** Sniff mime + pixel size from the first bytes of PNG, JPEG, BMP or TIFF data. */
export function imageInfo(buf) {
  if (!buf || buf.length < 26) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { mime: 'image/bmp', width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
    return { mime: 'image/jpeg', width: null, height: null };
  }
  if (buf.toString('ascii', 0, 2) === 'II' || buf.toString('ascii', 0, 2) === 'MM') {
    return { mime: 'image/tiff', width: null, height: null };
  }
  return null;
}

/** 7-segment digit renderer so simulated pages carry a visible page number. */
const SEGMENTS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'];
export function drawNumber(raster, text, x, y, h, color) {
  const w = h / 2;
  const t = Math.max(2, h / 10);
  let cx = x;
  for (const ch of String(text)) {
    const d = Number(ch);
    if (Number.isInteger(d)) {
      const seg = SEGMENTS[d];
      if (seg.includes('a')) raster.fillRect(cx, y, w, t, color);
      if (seg.includes('b')) raster.fillRect(cx + w - t, y, t, h / 2, color);
      if (seg.includes('c')) raster.fillRect(cx + w - t, y + h / 2, t, h / 2, color);
      if (seg.includes('d')) raster.fillRect(cx, y + h - t, w, t, color);
      if (seg.includes('e')) raster.fillRect(cx, y + h / 2, t, h / 2, color);
      if (seg.includes('f')) raster.fillRect(cx, y, t, h / 2, color);
      if (seg.includes('g')) raster.fillRect(cx, y + h / 2 - t / 2, w, t, color);
    }
    cx += w * 1.4;
  }
}
