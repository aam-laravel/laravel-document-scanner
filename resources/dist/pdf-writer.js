/**
 * Minimal PDF 1.4 writer for scanned pages (no dependencies).
 * Each page embeds one JPEG (DCTDecode) drawn at its physical size:
 * page size in points = pixels / dpi * 72, so scans keep their real
 * dimensions and pages may have different sizes. No object streams,
 * no compression of the structure, so the result is easy to verify.
 */
const enc = new TextEncoder();

/**
 * @param {Array<{jpeg: Uint8Array, width: number, height: number, dpi: number, components?: 1|3}>} pages
 * @param {{title?: string, producer?: string, date?: Date}} [meta]
 * @returns {Uint8Array}
 */
export function buildPdf(pages, meta = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('NO_PAGES');
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const beginObj = (n) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
  };

  // header + binary comment so transfer tools treat the file as binary
  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const n = pages.length;
  const pageObj = (i) => 4 + i * 3;
  const contentObj = (i) => 5 + i * 3;
  const imageObj = (i) => 6 + i * 3;

  beginObj(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  beginObj(2);
  push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>\nendobj\n`);
  beginObj(3);
  const date = pdfDate(meta.date || new Date());
  push(`<< /Producer ${pdfString(meta.producer || 'laravel-document-scanner')} /CreationDate ${pdfString(date)}${meta.title ? ` /Title ${pdfString(meta.title)}` : ''} >>\nendobj\n`);

  pages.forEach((p, i) => {
    if (!(p.jpeg instanceof Uint8Array) || p.jpeg[0] !== 0xff || p.jpeg[1] !== 0xd8) throw new Error(`Page ${i + 1} is not JPEG data`);
    if (!(p.width > 0 && p.height > 0)) throw new Error(`Page ${i + 1} has no size`);
    const dpi = p.dpi > 0 ? p.dpi : 72;
    const w = round2((p.width / dpi) * 72);
    const h = round2((p.height / dpi) * 72);
    const cs = p.components === 1 ? '/DeviceGray' : '/DeviceRGB';

    beginObj(pageObj(i));
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im${i} ${imageObj(i)} 0 R >> /ProcSet [/PDF /ImageC /ImageB] >> /Contents ${contentObj(i)} 0 R >>\nendobj\n`);

    const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im${i} Do\nQ\n`;
    beginObj(contentObj(i));
    push(`<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);

    beginObj(imageObj(i));
    push(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    push(p.jpeg);
    push('\nendstream\nendobj\n');
  });

  const count = 4 + n * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/**
 * Structural self-check of a PDF produced by buildPdf (header, trailer, xref
 * offsets and page count). Returns the page count or throws.
 */
export function verifyPdf(bytes, expectedPages) {
  const text = latin1(bytes);
  if (!text.startsWith('%PDF-1.')) throw new Error('header');
  if (!/%%EOF\s*$/.test(text.slice(-64))) throw new Error('trailer');
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text.slice(-128));
  if (!sx || !text.startsWith('xref', Number(sx[1]))) throw new Error('xref');
  // check every xref offset points at its object
  const table = text.slice(Number(sx[1])).split('\n');
  const size = Number(/^0 (\d+)$/.exec(table[1])?.[1]);
  for (let i = 1; i < size; i++) {
    const off = Number(table[2 + i].slice(0, 10));
    if (!text.startsWith(`${i} 0 obj`, off)) throw new Error(`xref offset of object ${i}`);
  }
  const structure = text.replace(/stream\n[\s\S]*?\nendstream/g, '');
  const pages = (structure.match(/\/Type \/Page(?![a-zA-Z])/g) || []).length;
  const declared = Number(/\/Type \/Pages \/Count (\d+)/.exec(structure)?.[1]);
  if (pages !== declared) throw new Error('page tree');
  if (expectedPages !== undefined && pages !== expectedPages) throw new Error('PDF_PAGE_MISMATCH');
  return pages;
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function pdfDate(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** PDF text string: ASCII literal, or UTF-16BE hex for non-ASCII (e.g. Arabic titles). */
export function pdfString(s) {
  const str = String(s);
  if (/^[\x20-\x7e]*$/.test(str)) return `(${str.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  let hex = 'FEFF';
  for (let i = 0; i < str.length; i++) hex += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}
