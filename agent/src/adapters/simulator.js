import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AgentError } from '../errors.js';
import { Raster, drawNumber } from '../image.js';
import { paperSizesFor } from '../capabilities.js';

/**
 * Simulator adapter: deterministic fake scanners for developing and testing the
 * UI and workflow without hardware. Every device it returns is flagged
 * `simulated: true` and the browser UI shows a clear "simulator" banner.
 */
const DEVICES = [
  {
    id: 'sim:flatbed',
    name: 'Simulated Flatbed Scanner',
    manufacturer: 'Simulator',
    sources: [
      { id: 'flatbed', kind: 'flatbed', label: 'Flatbed', colorModes: ['color', 'gray', 'bw'], resolutions: [75, 150, 300, 600], defaultResolution: 150, maxArea: { widthMm: 216, heightMm: 297 }, minArea: { widthMm: 10, heightMm: 10 }, brightness: { min: -100, max: 100, step: 1 }, contrast: { min: -100, max: 100, step: 1 } },
    ],
  },
  {
    id: 'sim:adf',
    name: 'Simulated ADF Duplex Scanner',
    manufacturer: 'Simulator',
    sources: [
      { id: 'flatbed', kind: 'flatbed', label: 'Flatbed', colorModes: ['color', 'gray'], resolutions: [100, 200, 300], defaultResolution: 200, maxArea: { widthMm: 216, heightMm: 356 }, minArea: { widthMm: 10, heightMm: 10 } },
      { id: 'feeder', kind: 'feeder', label: 'ADF (one side)', colorModes: ['color', 'gray'], resolutions: [100, 200, 300], defaultResolution: 200, maxArea: { widthMm: 216, heightMm: 356 }, minArea: { widthMm: 50, heightMm: 50 } },
      { id: 'duplex', kind: 'duplex', label: 'ADF (both sides)', colorModes: ['color', 'gray'], resolutions: [100, 200, 300], defaultResolution: 200, maxArea: { widthMm: 216, heightMm: 356 }, minArea: { widthMm: 50, heightMm: 50 } },
    ],
  },
  {
    id: 'sim:jam',
    name: 'Simulated Faulty Feeder (jams on page 2)',
    manufacturer: 'Simulator',
    failure: { atPage: 2, code: 'PAPER_JAM' },
    sources: [
      { id: 'feeder', kind: 'feeder', label: 'ADF', colorModes: ['gray', 'bw'], resolutions: { min: 50, max: 300, step: 50 }, defaultResolution: 150, maxArea: { widthMm: 216, heightMm: 297 }, minArea: { widthMm: 50, heightMm: 50 } },
    ],
  },
];

export class SimulatorAdapter {
  constructor(options = {}) {
    this.name = 'simulator';
    this.pageDelayMs = options.pageDelayMs ?? 600;
    this.feederSheets = options.feederSheets ?? 3;
  }

  async isAvailable() {
    return { available: true };
  }

  async listDevices() {
    return DEVICES.map((d) => ({ id: d.id, name: d.name, manufacturer: d.manufacturer, adapter: this.name, simulated: true, status: 'ready' }));
  }

  async getCapabilities(deviceId) {
    const d = find(deviceId);
    return {
      device: { id: d.id, name: d.name, manufacturer: d.manufacturer, adapter: this.name, simulated: true },
      status: { state: 'ready', feederLoaded: this.feederSheets > 0 },
      sources: d.sources.map((s) => ({
        ...s,
        duplex: s.kind === 'duplex',
        customArea: true,
        paperSizes: paperSizesFor(s.maxArea, s.minArea),
        brightness: s.brightness || null,
        contrast: s.contrast || null,
      })),
      notes: ['Simulated device: images are generated, no hardware is used.'],
    };
  }

  /**
   * @param {string} deviceId
   * @param {object} settings validated settings (see capabilities.validateSettings)
   * @param {{outDir: string, signal: AbortSignal, onPage: (p: object) => void, onProgress?: (p: object) => void}} ctx
   */
  async scan(deviceId, settings, ctx) {
    const d = find(deviceId);
    const isFeeder = settings.sourceKind !== 'flatbed';
    const duplex = settings.sourceKind === 'duplex';
    const sheets = isFeeder ? this.feederSheets : 1;
    if (isFeeder && sheets === 0) throw new AgentError('FEEDER_EMPTY', 'The document feeder is empty.');

    let index = 0;
    for (let sheet = 1; sheet <= sheets; sheet++) {
      for (const side of duplex ? ['front', 'back'] : [isFeeder ? 'front' : null]) {
        if (index >= settings.maxPages) return;
        ctx.signal.throwIfAborted();
        ctx.onProgress?.({ stage: 'scanning', page: index + 1 });
        await sleep(this.pageDelayMs, undefined, { signal: ctx.signal }).catch(() => ctx.signal.throwIfAborted());
        if (d.failure && index + 1 === d.failure.atPage) {
          throw new AgentError(d.failure.code, 'Paper jam reported by the (simulated) feeder.', { page: index + 1 });
        }
        const file = join(ctx.outDir, `page-${String(index + 1).padStart(4, '0')}.png`);
        const raster = renderPage(settings, index + 1, side);
        await writeFile(file, raster.toPng(), { mode: 0o600 });
        ctx.onPage({ file, mime: 'image/png', width: raster.width, height: raster.height, dpi: settings.resolution, colorMode: settings.colorMode, side });
        index++;
      }
    }
  }
}

function find(deviceId) {
  const d = DEVICES.find((x) => x.id === deviceId);
  if (!d) throw new AgentError('DEVICE_NOT_FOUND', 'Scanner not found.', { deviceId });
  return d;
}

function renderPage(settings, pageNo, side) {
  const px = (mm) => Math.max(1, Math.round((mm / 25.4) * settings.resolution));
  const w = px(settings.area.widthMm);
  const h = px(settings.area.heightMm);
  const raster = new Raster(w, h, settings.colorMode === 'color' ? 3 : 1);
  const accent = side === 'back' ? [170, 60, 40] : [30, 90, 170];
  const ink = [40, 40, 40];
  const m = px(12);
  raster.fillRect(m, m, w - 2 * m, px(1), ink);
  raster.fillRect(m, h - m, w - 2 * m, px(1), ink);
  raster.fillRect(m, m + px(4), w - 2 * m, px(22), accent);
  drawNumber(raster, String(pageNo), m + px(6), m + px(8), px(14), [255, 255, 255]);
  if (side === 'back') raster.fillRect(w - m - px(30), m + px(8), px(20), px(14), [255, 255, 255]);
  // fake text lines with varied lengths so thumbnails look like documents
  for (let y = m + px(40), i = 0; y < h - m - px(10); y += px(8), i++) {
    const len = 0.45 + (((pageNo * 31 + i * 17) % 50) / 100);
    raster.fillRect(m + px(4), y, (w - 2 * m - px(8)) * len, px(2.4), ink);
  }
  raster.adjust({ brightness: settings.brightness || 0, contrast: settings.contrast || 0, threshold: settings.colorMode === 'bw' ? 128 : null });
  return raster;
}
