/**
 * Canvas-based image processing in the browser. Everything here is applied
 * *after* capture and is labelled as such in the UI (software conversion,
 * blank-page suggestion, rotation); it never pretends to be a scanner mode.
 */

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function toBlob(c, type, quality) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality));
}

/** Luma-based conversion: "gray" or "bw" (fixed threshold 128). */
export function convertPixels(data, mode) {
  for (let i = 0; i < data.length; i += 4) {
    let y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (mode === 'bw') y = y >= 128 ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = y;
  }
  return data;
}

/**
 * Blank-page heuristic on RGBA data: ignores a 6% margin, counts "ink"
 * pixels darker than the page background. Returns {blank, inkRatio}.
 * It is only a suggestion; the user confirms removal.
 */
export function analyseBlank(data, width, height, { inkThreshold = 0.004 } = {}) {
  const mx = Math.floor(width * 0.06);
  const my = Math.floor(height * 0.06);
  let sum = 0;
  let n = 0;
  for (let y = my; y < height - my; y++) {
    for (let x = mx; x < width - mx; x++) {
      const i = (y * width + x) * 4;
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n++;
    }
  }
  if (!n) return { blank: false, inkRatio: 1 };
  const bg = sum / n;
  let ink = 0;
  for (let y = my; y < height - my; y++) {
    for (let x = mx; x < width - mx; x++) {
      const i = (y * width + x) * 4;
      if (bg - (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) > 60) ink++;
    }
  }
  const inkRatio = ink / n;
  return { blank: inkRatio < inkThreshold, inkRatio };
}

/** Decode, optionally convert colour (software), and analyse for blankness. */
export async function processScannedImage(blob, { conversion = null, detectBlank = true } = {}) {
  const bmp = await createImageBitmap(blob);
  try {
    let out = blob;
    if (conversion) {
      const c = canvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
      convertPixels(img.data, conversion);
      ctx.putImageData(img, 0, 0);
      out = await toBlob(c, 'image/png');
    }
    let blank = false;
    if (detectBlank) {
      const scale = Math.min(1, 200 / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const c = canvas(w, h);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0, w, h);
      blank = analyseBlank(ctx.getImageData(0, 0, w, h).data, w, h).blank;
    }
    return { blob: out, width: bmp.width, height: bmp.height, blank };
  } finally {
    bmp.close?.();
  }
}

/**
 * Render a page for the PDF: apply rotation and encode JPEG. Refuses (rather
 * than silently downscaling) images above maxPixels.
 */
export async function renderForPdf(page, { quality = 0.85, maxPixels = 40_000_000 } = {}) {
  const bmp = await createImageBitmap(page.blob);
  try {
    if (bmp.width * bmp.height > maxPixels) {
      const e = new Error('image too large');
      e.code = 'OUT_OF_MEMORY';
      throw e;
    }
    const quarter = page.rotation === 90 || page.rotation === 270;
    const w = quarter ? bmp.height : bmp.width;
    const h = quarter ? bmp.width : bmp.height;
    const c = canvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate((page.rotation * Math.PI) / 180);
    ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    const jpeg = new Uint8Array(await (await toBlob(c, 'image/jpeg', quality)).arrayBuffer());
    if (c.width) {
      c.width = 1; // release backing store early
      c.height = 1;
    }
    return { jpeg, width: w, height: h, dpi: page.dpi || 72 };
  } finally {
    bmp.close?.();
  }
}
