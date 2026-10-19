import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { release } from 'node:os';
import { AgentError } from '../errors.js';
import { AGENT_ROOT } from '../version.js';
import { PAPER_PRESETS, paperSizesFor, round1 } from '../capabilities.js';
import { imageInfo } from '../image.js';
import { mapWiaError } from './wia.js';
import { runPowerShellBridge } from './ps-bridge.js';

const SCRIPT = join(AGENT_ROOT, 'scripts', 'winrt.ps1');

/** PrintMediaSize names the driver may declare for the feeder → our preset ids. */
const MEDIA_TO_PRESET = { IsoA3: 'a3', IsoA4: 'a4', IsoA5: 'a5', IsoA6: 'a6', NorthAmericaLetter: 'letter', NorthAmericaLegal: 'legal' };
const PRESET_TO_MEDIA = Object.fromEntries(Object.entries(MEDIA_TO_PRESET).map(([k, v]) => [v, k]));
const COLOR = { color: 'Color', gray: 'Grayscale', bw: 'Monochrome' };

const inchToMm = (v) => round1(Number(v) * 25.4);

function range(r) {
  return r && r.max > r.min ? { min: r.min, max: r.max, step: r.step || 1 } : null;
}

function resolutions(src) {
  const min = Math.round(src.minDpi);
  const max = Math.round(src.maxDpi);
  return max > min ? { min, max, step: null } : [min];
}

/**
 * Convert raw Windows.Devices.Scanners values (winrt.ps1 "caps") into the
 * unified capability model. Exported for unit tests with recorded fixtures.
 * Feeder paper sizes come from the driver's own list (IsPageSizeSupported);
 * the flatbed has no size list in this API, so presets that fit its declared
 * maximum area are offered there, plus a custom region.
 */
export function buildWinRtCapabilities(device, raw) {
  const sources = [];
  const base = (src) => {
    const colorModes = ['color', 'gray', 'bw'].filter((m) => src[m]);
    const res = resolutions(src);
    return {
      colorModes,
      resolutions: res,
      defaultResolution: Math.round(src.defaultDpi) || (Array.isArray(res) ? res[0] : res.min),
      maxArea: { widthMm: inchToMm(src.maxArea.w), heightMm: inchToMm(src.maxArea.h) },
      minArea: { widthMm: inchToMm(src.minArea.w), heightMm: inchToMm(src.minArea.h) },
      brightness: range(src.brightness),
      contrast: range(src.contrast),
      winrtFormat: src.formats?.png ? 'Png' : src.formats?.jpeg ? 'Jpeg' : 'DeviceIndependentBitmap',
    };
  };

  if (raw.flatbed) {
    const b = base(raw.flatbed);
    sources.push({ id: 'flatbed', kind: 'flatbed', label: 'Flatbed', duplex: false, ...b, customArea: true, paperSizes: paperSizesFor(b.maxArea, b.minArea) });
  }
  if (raw.feeder) {
    const b = base(raw.feeder);
    const declared = (raw.feeder.pageSizes || []).map((n) => MEDIA_TO_PRESET[n]).filter(Boolean);
    const paperSizes = PAPER_PRESETS.filter((p) => declared.includes(p.id)).map((p) => ({ ...p }));
    if (paperSizes.length) {
      sources.push({ id: 'feeder', kind: 'feeder', label: 'Document feeder (one side)', duplex: false, ...b, customArea: false, paperSizes });
      if (raw.feeder.duplex) sources.push({ id: 'duplex', kind: 'duplex', label: 'Document feeder (both sides)', duplex: true, ...b, customArea: false, paperSizes });
    }
  }

  return {
    device: { ...device, simulated: false },
    // This API reports no live cover/jam state; problems surface as scan errors.
    status: { state: 'ready', reportedByDriver: false },
    sources: sources.filter((s) => s.colorModes.length),
    notes: [
      'Windows.Devices.Scanners (WIA 2.0). Feeder jobs return every page of the stack.',
      'Feeder paper sizes are the sizes declared by the driver; flatbed sizes are presets that fit the declared maximum area.',
    ],
  };
}

/** Settings → payload for winrt.ps1 (exported for tests). */
export function scanPayload(source, settings) {
  const payload = {
    source: source.kind === 'flatbed' ? 'Flatbed' : 'Feeder',
    format: source.winrtFormat,
    colorMode: COLOR[settings.colorMode],
    dpi: settings.resolution,
    brightness: settings.brightness ?? null,
    contrast: settings.contrast ?? null,
  };
  if (source.kind === 'flatbed') {
    payload.widthIn = Math.round((settings.area.widthMm / 25.4) * 1000) / 1000;
    payload.heightIn = Math.round((settings.area.heightMm / 25.4) * 1000) / 1000;
  } else {
    const media = PRESET_TO_MEDIA[settings.area.id];
    if (!media) throw new AgentError('UNSUPPORTED_SETTING', 'Paper size not supported by the feeder.', { setting: 'paper', value: settings.area.id });
    payload.pageSize = media;
    payload.duplex = source.kind === 'duplex';
    // A duplex sheet yields two images; the driver counts pages, not sheets.
    payload.maxPages = settings.maxPages;
  }
  return payload;
}

export class WinRtAdapter {
  constructor({ powershell = 'powershell.exe', timeoutMs = 600_000 } = {}) {
    this.name = 'winrt';
    this.powershell = powershell;
    this.timeoutMs = timeoutMs;
    this.capsCache = new Map();
  }

  async isAvailable() {
    if (process.platform !== 'win32') return { available: false, reason: 'Windows.Devices.Scanners is only available on Windows.' };
    if (Number(release().split('.')[0]) < 10) return { available: false, reason: 'Requires Windows 10 or later.' };
    if (!existsSync(SCRIPT)) return { available: false, reason: 'winrt.ps1 bridge script is missing.' };
    return { available: true };
  }

  run(args, opts = {}) {
    return runPowerShellBridge(SCRIPT, args, { powershell: this.powershell, timeoutMs: opts.timeoutMs, signal: opts.signal, onEvent: opts.onEvent, mapError: mapWiaError, label: 'Windows scanning' });
  }

  async listDevices() {
    const events = await this.run(['-Action', 'list'], { timeoutMs: 30_000 });
    const list = events.find((e) => e.type === 'devices')?.devices || [];
    return (Array.isArray(list) ? list : [list])
      .filter((d) => d.enabled !== false)
      .map((d) => ({ id: `win:${d.id}`, name: d.name || 'Scanner', manufacturer: '', adapter: this.name, simulated: false, status: 'unknown' }));
  }

  async getCapabilities(deviceId) {
    const cached = this.capsCache.get(deviceId);
    if (cached && cached.at > Date.now() - 60_000) return cached.caps;
    const device = (await this.listDevices()).find((d) => d.id === deviceId);
    if (!device) throw new AgentError('DEVICE_NOT_FOUND', 'Scanner not found.');
    const events = await this.run(['-Action', 'caps', '-DeviceId', nativeId(deviceId)], { timeoutMs: 45_000 });
    const raw = events.find((e) => e.type === 'caps');
    if (!raw) throw new AgentError('DRIVER_ERROR', 'Scanner returned no capabilities.');
    const caps = buildWinRtCapabilities(device, raw);
    if (!caps.sources.length) throw new AgentError('UNSUPPORTED_FEATURE', 'The driver exposes no usable scan source.');
    this.capsCache.set(deviceId, { at: Date.now(), caps });
    return caps;
  }

  async scan(deviceId, settings, ctx) {
    const caps = await this.getCapabilities(deviceId);
    const source = caps.sources.find((s) => s.id === settings.source);
    const payload = scanPayload(source, settings);

    // The driver writes files while the job runs; count them for live progress.
    const poll = setInterval(async () => {
      const n = (await readdir(ctx.outDir).catch(() => [])).length;
      ctx.onProgress?.({ stage: 'scanning', page: n + 1 });
    }, 700);
    const files = [];
    const deliver = async (list) => {
      for (const [i, file] of list.entries()) {
        const info = imageInfo(await readFile(file));
        if (!info) throw new AgentError('IMAGE_READ_FAILED', 'Scanned image could not be read.');
        const side = source.kind === 'duplex' ? (i % 2 ? 'back' : 'front') : source.kind === 'feeder' ? 'front' : null;
        ctx.onPage({ file, mime: info.mime, width: info.width, height: info.height, dpi: settings.resolution, colorMode: settings.colorMode, side });
      }
    };
    try {
      await this.run(['-Action', 'scan', '-DeviceId', nativeId(deviceId), '-Settings', Buffer.from(JSON.stringify(payload)).toString('base64'), '-OutDir', ctx.outDir], {
        timeoutMs: this.timeoutMs,
        signal: ctx.signal,
        onEvent: (ev) => ev.type === 'page' && files.push(ev.file),
      });
    } catch (e) {
      // A job that fails mid-stack (jam, cancel) has already written the earlier pages: keep them.
      await deliver(await completedFiles(ctx.outDir)).catch(() => {});
      throw e;
    } finally {
      clearInterval(poll);
    }
    if (!files.length && source.kind !== 'flatbed') throw new AgentError('FEEDER_EMPTY', 'The document feeder is empty.');
    await deliver(files);
  }
}

/** Readable image files in scan order (oldest first); half-written files are skipped by imageInfo later. */
async function completedFiles(dir) {
  const names = await readdir(dir).catch(() => []);
  const entries = await Promise.all(names.filter((n) => /\.(jpe?g|png|bmp)$/i.test(n)).map(async (n) => ({ file: join(dir, n), at: (await stat(join(dir, n))).mtimeMs })));
  return entries.sort((a, b) => a.at - b.at).map((e) => e.file);
}

function nativeId(deviceId) {
  if (!deviceId.startsWith('win:')) throw new AgentError('DEVICE_NOT_FOUND', 'Scanner not found.');
  return deviceId.slice(4);
}
