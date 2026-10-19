import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { AgentError } from '../errors.js';
import { AGENT_ROOT } from '../version.js';
import { paperSizesFor, round1 } from '../capabilities.js';
import { imageInfo } from '../image.js';
import { runPowerShellBridge } from './ps-bridge.js';

const SCRIPT = join(AGENT_ROOT, 'scripts', 'wia.ps1');

// WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES / _SELECT flags (wiadef.h)
const FEED = 0x1;
const FLAT = 0x2;
const DUP = 0x4;
// WIA_DPS_DOCUMENT_HANDLING_STATUS flags (as reported by the driver)
const STATUS = { FEED_READY: 0x1, FLAT_READY: 0x2, DUP_READY: 0x4, FLAT_COVER_UP: 0x8, PATH_COVER_UP: 0x10, PAPER_JAM: 0x20, DEVICE_ATTENTION: 0x400 };
// WIA_IPA_DATATYPE values
const DATATYPE = { bw: 0, gray: 2, color: 3 };

/** WIA HRESULTs → unified error codes. */
export const HRESULT_MAP = {
  '0x80210001': 'HARDWARE_ERROR', // WIA_ERROR_GENERAL_ERROR
  '0x80210002': 'PAPER_JAM',
  '0x80210003': 'FEEDER_EMPTY', // WIA_ERROR_PAPER_EMPTY
  '0x80210004': 'PAPER_FEED_FAILED', // WIA_ERROR_PAPER_PROBLEM
  '0x80210005': 'DEVICE_OFFLINE',
  '0x80210006': 'DEVICE_BUSY',
  '0x80210007': 'WARMING_UP',
  '0x80210008': 'HARDWARE_ERROR', // WIA_ERROR_USER_INTERVENTION
  '0x80210009': 'DEVICE_OFFLINE', // WIA_ERROR_ITEM_DELETED
  '0x8021000A': 'DEVICE_OFFLINE', // WIA_ERROR_DEVICE_COMMUNICATION
  '0x8021000B': 'DRIVER_ERROR', // WIA_ERROR_INVALID_COMMAND
  '0x8021000C': 'UNSUPPORTED_SETTING', // WIA_ERROR_INCORRECT_HARDWARE_SETTING
  '0x8021000D': 'DEVICE_BUSY', // WIA_ERROR_DEVICE_LOCKED
  '0x8021000E': 'DRIVER_ERROR', // WIA_ERROR_EXCEPTION_IN_DRIVER
  '0x8021000F': 'DRIVER_ERROR', // WIA_ERROR_INVALID_DRIVER_RESPONSE
  '0x80210015': 'DEVICE_NOT_FOUND', // WIA_S_NO_DEVICE_AVAILABLE
  '0x80210016': 'COVER_OPEN',
  '0x80210017': 'HARDWARE_ERROR', // WIA_ERROR_LAMP_OFF
  '0x80070005': 'PERMISSION_DENIED',
  '0x8007000E': 'OUT_OF_MEMORY',
  '0x80070070': 'DISK_FULL',
  '0x80070057': 'UNSUPPORTED_SETTING', // E_INVALIDARG while applying a property
  '0x80040154': 'DRIVER_MISSING', // class not registered (WIA automation missing)
};

export function mapWiaError(ev) {
  const hr = String(ev.hresult || '').toUpperCase().replace('0X', '0x');
  // 0x8019xxxx = HTTP status from network/eSCL scanners (e.g. 0x801901F4 = HTTP 500 from the device)
  if (hr.startsWith('0x8019')) {
    const httpStatus = parseInt(hr.slice(-3), 16);
    return new AgentError('HARDWARE_ERROR', `Scanner returned HTTP ${httpStatus}.`, { hresult: ev.hresult, stage: ev.stage, httpStatus });
  }
  const code = HRESULT_MAP[(ev.hresult || '').toUpperCase().replace('0X', '0x')] || (ev.stage === 'apply-settings' ? 'UNSUPPORTED_SETTING' : 'DRIVER_ERROR');
  return new AgentError(code, `Scanner reported: ${code.toLowerCase().replace(/_/g, ' ')}.`, { hresult: ev.hresult, stage: ev.stage });
}

const thousandthsInchToMm = (v) => round1((Number(v) / 1000) * 25.4);

function resolutionsFrom(desc) {
  if (!desc) return [];
  if (desc.subType === 1 && desc.max > desc.min) return { min: desc.min, max: desc.max, step: desc.step || 1 };
  if (Array.isArray(desc.values) && desc.values.length) return [...new Set(desc.values.map(Number))].sort((a, b) => a - b);
  return desc.value ? [Number(desc.value)] : [];
}

function rangeFrom(desc) {
  if (!desc || desc.subType !== 1 || !(desc.max > desc.min) || desc.readOnly) return null;
  return { min: desc.min, max: desc.max, step: desc.step || 1 };
}

function colorModesFrom(desc) {
  const values = desc?.values?.length ? desc.values.map(Number) : desc ? [Number(desc.value)] : [];
  return ['color', 'gray', 'bw'].filter((m) => values.includes(DATATYPE[m]));
}

/**
 * Convert raw WIA capability data (from wia.ps1 "caps") into the unified
 * capability model. Exported for unit tests with recorded fixtures.
 */
export function buildCapabilities(device, raw) {
  const handling = Number(raw.handlingCapabilities?.value ?? FLAT);
  const status = Number(raw.handlingStatus?.value ?? 0);
  const selectable = raw.handlingSelect && !raw.handlingSelect.readOnly;
  const bed = raw.bedSize?.[0]?.value ? { widthMm: thousandthsInchToMm(raw.bedSize[0].value), heightMm: thousandthsInchToMm(raw.bedSize[1].value) } : null;
  const feed = raw.sheetFeedSize?.[0]?.value ? { widthMm: thousandthsInchToMm(raw.sheetFeedSize[0].value), heightMm: thousandthsInchToMm(raw.sheetFeedSize[1].value) } : null;
  const feedMin = raw.minSheetFeedSize?.[0]?.value ? { widthMm: thousandthsInchToMm(raw.minSheetFeedSize[0].value), heightMm: thousandthsInchToMm(raw.minSheetFeedSize[1].value) } : null;

  const candidates = [];
  if (!selectable) candidates.push({ sel: 0, id: 'flatbed', kind: 'flatbed', label: 'Default source', area: bed });
  else {
    if (handling & FLAT) candidates.push({ sel: FLAT, id: 'flatbed', kind: 'flatbed', label: 'Flatbed', area: bed });
    if (handling & FEED) candidates.push({ sel: FEED, id: 'feeder', kind: 'feeder', label: 'Document feeder (one side)', area: feed, minArea: feedMin });
    if (handling & FEED && handling & DUP) candidates.push({ sel: FEED | DUP, id: 'duplex', kind: 'duplex', label: 'Document feeder (both sides)', area: feed, minArea: feedMin });
  }

  const sources = [];
  for (const c of candidates) {
    const item = raw.perSelect?.[String(c.sel)];
    if (!item || item.error) continue;
    const resolutions = resolutionsFrom(item.xres);
    const colorModes = colorModesFrom(item.dataType);
    if (!colorModes.length || (Array.isArray(resolutions) && !resolutions.length)) continue;
    // Fall back to the extent limits at the current resolution when no bed size is declared.
    const area = c.area || (item.xextent?.max && item.xres?.value ? { widthMm: round1((item.xextent.max / item.xres.value) * 25.4), heightMm: round1((item.yextent.max / item.yres.value) * 25.4) } : null);
    if (!area) continue;
    const def = Number(item.xres?.value);
    sources.push({
      id: c.id,
      kind: c.kind,
      label: c.label,
      duplex: c.kind === 'duplex',
      wiaSelect: c.sel,
      colorModes,
      resolutions,
      defaultResolution: Array.isArray(resolutions) ? (resolutions.includes(def) ? def : resolutions[0]) : def,
      maxArea: area,
      minArea: c.minArea || null,
      customArea: item.xextent?.subType === 1 && item.yextent?.subType === 1,
      paperSizes: paperSizesFor(area, c.minArea),
      brightness: rangeFrom(item.brightness),
      contrast: rangeFrom(item.contrast),
    });
  }

  const flags = {};
  if (raw.handlingStatus) {
    flags.feederReady = Boolean(status & STATUS.FEED_READY);
    flags.coverOpen = Boolean(status & (STATUS.FLAT_COVER_UP | STATUS.PATH_COVER_UP));
    flags.paperJam = Boolean(status & STATUS.PAPER_JAM);
    flags.attention = Boolean(status & STATUS.DEVICE_ATTENTION);
  }
  return {
    device: { ...device, simulated: false },
    status: { state: flags.paperJam ? 'paper_jam' : flags.coverOpen ? 'cover_open' : 'ready', reportedByDriver: Boolean(raw.handlingStatus), ...flags },
    sources,
    notes: [
      `WIA ${raw.wiaVersion || '?'} via the WIA Automation Library. Options are limited to what the driver exposes through this interface.`,
      'Paper sizes are standard presets that fit the maximum area declared by the driver.',
    ],
  };
}

export class WiaAdapter {
  constructor({ powershell = 'powershell.exe', timeoutMs = 600_000 } = {}) {
    this.name = 'wia';
    this.powershell = powershell;
    this.timeoutMs = timeoutMs;
    this.capsCache = new Map();
  }

  async isAvailable() {
    if (process.platform !== 'win32') return { available: false, reason: 'WIA is only available on Windows.' };
    if (!existsSync(SCRIPT)) return { available: false, reason: 'wia.ps1 bridge script is missing.' };
    return { available: true };
  }

  run(args, opts = {}) {
    return runPowerShellBridge(SCRIPT, args, { powershell: this.powershell, timeoutMs: opts.timeoutMs, signal: opts.signal, onEvent: opts.onEvent, mapError: mapWiaError, label: 'WIA' });
  }

  async listDevices() {
    const events = await this.run(['-Action', 'list'], { timeoutMs: 30_000 });
    const list = events.find((e) => e.type === 'devices')?.devices || [];
    return (Array.isArray(list) ? list : [list]).map((d) => ({
      id: `wia:${d.id}`,
      name: d.name || d.description || 'Scanner',
      manufacturer: d.manufacturer || '',
      adapter: this.name,
      simulated: false,
      status: 'unknown',
    }));
  }

  async getCapabilities(deviceId) {
    const cached = this.capsCache.get(deviceId);
    if (cached && cached.at > Date.now() - 60_000) return cached.caps;
    const native = nativeId(deviceId);
    const devices = await this.listDevices();
    const device = devices.find((d) => d.id === deviceId);
    if (!device) throw new AgentError('DEVICE_NOT_FOUND', 'Scanner not found.');
    const events = await this.run(['-Action', 'caps', '-DeviceId', native], { timeoutMs: 45_000 });
    const raw = events.find((e) => e.type === 'caps');
    if (!raw) throw new AgentError('DRIVER_ERROR', 'Scanner returned no capabilities.');
    const caps = buildCapabilities(device, raw);
    if (!caps.sources.length) throw new AgentError('UNSUPPORTED_FEATURE', 'The driver exposes no usable scan source through WIA.');
    this.capsCache.set(deviceId, { at: Date.now(), caps });
    return caps;
  }

  async scan(deviceId, settings, ctx) {
    const caps = await this.getCapabilities(deviceId);
    const source = caps.sources.find((s) => s.id === settings.source);
    const px = (mm) => Math.round((mm / 25.4) * settings.resolution);
    const payload = {
      select: source.wiaSelect,
      dataType: DATATYPE[settings.colorMode],
      dpi: settings.resolution,
      widthPx: px(settings.area.widthMm),
      heightPx: px(settings.area.heightMm),
      maxPages: settings.maxPages,
      brightness: settings.brightness ?? null,
      contrast: settings.contrast ?? null,
    };
    let chain = Promise.resolve(); // keeps pages in scan order
    let back = false;
    await this.run(
      ['-Action', 'scan', '-DeviceId', nativeId(deviceId), '-Settings', Buffer.from(JSON.stringify(payload)).toString('base64'), '-OutDir', ctx.outDir],
      {
        timeoutMs: this.timeoutMs,
        signal: ctx.signal,
        onEvent: (ev) => {
          if (ev.type === 'progress') ctx.onProgress?.({ stage: 'scanning', page: ev.page });
          if (ev.type !== 'page') return;
          const side = settings.sourceKind === 'duplex' ? (back ? 'back' : 'front') : settings.sourceKind === 'feeder' ? 'front' : null;
          back = !back;
          chain = chain.then(async () => {
            const info = imageInfo(await readFile(ev.file));
            if (!info) throw new AgentError('IMAGE_READ_FAILED', 'Scanned image could not be read.');
            ctx.onPage({ file: ev.file, mime: info.mime, width: info.width ?? ev.width, height: info.height ?? ev.height, dpi: ev.dpi || settings.resolution, colorMode: settings.colorMode, side });
          });
        },
      },
    ).catch(async (e) => {
      await chain.catch(() => {}); // deliver pages scanned before the failure
      throw e;
    });
    await chain;
  }
}

function nativeId(deviceId) {
  if (!deviceId.startsWith('wia:')) throw new AgentError('DEVICE_NOT_FOUND', 'Scanner not found.');
  return deviceId.slice(4);
}
