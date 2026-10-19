import { AgentError } from './errors.js';

/**
 * Standard paper presets (mm). They are only offered for a source when they fit
 * inside the maximum scan area *reported by that device/source*; the agent
 * never advertises a size the hardware did not declare room for.
 */
export const PAPER_PRESETS = [
  { id: 'a3', label: 'A3', widthMm: 297, heightMm: 420 },
  { id: 'a4', label: 'A4', widthMm: 210, heightMm: 297 },
  { id: 'a5', label: 'A5', widthMm: 148, heightMm: 210 },
  { id: 'a6', label: 'A6', widthMm: 105, heightMm: 148 },
  { id: 'letter', label: 'Letter', widthMm: 215.9, heightMm: 279.4 },
  { id: 'legal', label: 'Legal', widthMm: 215.9, heightMm: 355.6 },
];

const TOLERANCE_MM = 1.5;

/**
 * Build the list of paper sizes for a source from its declared max/min area.
 * "max" means the maximum scan area the driver allows for this source — for a
 * flatbed that is usually the glass size, for a feeder the widest/longest sheet.
 */
export function paperSizesFor(maxArea, minArea = null) {
  if (!maxArea) return [];
  const fits = (p) =>
    p.widthMm <= maxArea.widthMm + TOLERANCE_MM &&
    p.heightMm <= maxArea.heightMm + TOLERANCE_MM &&
    (!minArea || (p.widthMm >= minArea.widthMm && p.heightMm >= minArea.heightMm));
  return [
    ...PAPER_PRESETS.filter(fits).map((p) => ({ ...p, widthMm: Math.min(p.widthMm, maxArea.widthMm), heightMm: Math.min(p.heightMm, maxArea.heightMm) })),
    { id: 'max', label: 'Maximum area', widthMm: round1(maxArea.widthMm), heightMm: round1(maxArea.heightMm) },
  ];
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

/** Resolutions are either a discrete list or a {min,max,step} range. */
export function resolutionSupported(res, resolution) {
  if (!Number.isInteger(resolution)) return false;
  if (Array.isArray(res)) return res.includes(resolution);
  if (res && typeof res === 'object') {
    if (resolution < res.min || resolution > res.max) return false;
    return !res.step || (resolution - res.min) % res.step === 0;
  }
  return false;
}

function inRange(range, value) {
  return range && Number.isFinite(value) && value >= range.min && value <= range.max;
}

/**
 * Validate a scan request against capabilities the device actually reported.
 * Returns the normalised settings or throws UNSUPPORTED_SETTING / SOURCE_UNAVAILABLE.
 */
export function validateSettings(caps, input, { maxPages }) {
  if (!input || typeof input !== 'object') throw new AgentError('INVALID_REQUEST', 'Scan settings are required.');
  const source = caps.sources.find((s) => s.id === input.source);
  if (!source) throw new AgentError('SOURCE_UNAVAILABLE', 'The selected paper source is not available on this device.', { source: input.source });

  const colorMode = input.colorMode ?? source.colorModes[0];
  if (!source.colorModes.includes(colorMode)) {
    throw new AgentError('UNSUPPORTED_SETTING', 'Colour mode not supported by this source.', { setting: 'colorMode', value: colorMode, supported: source.colorModes });
  }
  const resolution = input.resolution ?? source.defaultResolution;
  if (!resolutionSupported(source.resolutions, resolution)) {
    throw new AgentError('UNSUPPORTED_SETTING', 'Resolution not supported by this source.', { setting: 'resolution', value: resolution, supported: source.resolutions });
  }

  let area;
  if (input.paper && typeof input.paper === 'object' && input.paper.id === 'custom') {
    if (!source.customArea) throw new AgentError('UNSUPPORTED_SETTING', 'Custom scan area is not supported by this source.', { setting: 'paper' });
    const w = Number(input.paper.widthMm);
    const h = Number(input.paper.heightMm);
    const min = source.minArea || { widthMm: 1, heightMm: 1 };
    if (!(w >= min.widthMm && h >= min.heightMm && w <= source.maxArea.widthMm + TOLERANCE_MM && h <= source.maxArea.heightMm + TOLERANCE_MM)) {
      throw new AgentError('UNSUPPORTED_SETTING', 'Custom area is outside the device limits.', { setting: 'paper', min, max: source.maxArea });
    }
    area = { id: 'custom', widthMm: Math.min(w, source.maxArea.widthMm), heightMm: Math.min(h, source.maxArea.heightMm) };
  } else {
    const id = (input.paper && input.paper.id) || input.paper || source.paperSizes[0]?.id;
    const preset = source.paperSizes.find((p) => p.id === id);
    if (!preset) throw new AgentError('UNSUPPORTED_SETTING', 'Paper size not supported by this source.', { setting: 'paper', value: id, supported: source.paperSizes.map((p) => p.id) });
    area = { id: preset.id, widthMm: preset.widthMm, heightMm: preset.heightMm };
  }

  const out = { source: source.id, sourceKind: source.kind, colorMode, resolution, area };
  for (const key of ['brightness', 'contrast']) {
    if (input[key] === undefined || input[key] === null || input[key] === 0) continue;
    if (!source[key]) throw new AgentError('UNSUPPORTED_SETTING', `${key} is not adjustable on this device.`, { setting: key });
    if (!inRange(source[key], Number(input[key]))) {
      throw new AgentError('UNSUPPORTED_SETTING', `${key} is outside the device range.`, { setting: key, range: source[key] });
    }
    out[key] = Number(input[key]);
  }
  const pages = input.maxPages ?? maxPages;
  if (!Number.isInteger(pages) || pages < 1 || pages > maxPages) {
    throw new AgentError('UNSUPPORTED_SETTING', `maxPages must be between 1 and ${maxPages}.`, { setting: 'maxPages' });
  }
  out.maxPages = source.kind === 'flatbed' ? 1 : pages;
  return out;
}
