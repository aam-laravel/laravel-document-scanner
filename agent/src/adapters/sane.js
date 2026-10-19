import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError } from '../errors.js';
import { paperSizesFor, round1 } from '../capabilities.js';
import { imageInfo } from '../image.js';
import { runProcess } from './process.js';

/**
 * SANE adapter (Linux) driving the `scanimage` CLI from sane-backends.
 * Options are parsed from `scanimage --all-options` per source, so only what
 * the backend declares is exposed.
 */

/** Parse `scanimage -L` output. */
export function parseDeviceList(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^device [`'](.+?)' is a (.+)$/.exec(line.trim());
    if (m) out.push({ id: m[1], description: m[2].trim() });
  }
  return out;
}

/**
 * Parse `scanimage -d DEV -A` into { name: {values|range, unit, current, inactive} }.
 * Handles lines like:
 *   --mode Lineart|Gray|Color [Color]
 *   --resolution 75|150|300dpi [75]
 *   --resolution 50..1200dpi (in steps of 1) [300]
 *   -x 0..215.9mm (in steps of 0.0999908) [215.9]
 *   --source Flatbed|ADF|ADF Duplex [Flatbed]
 */
export function parseOptions(text) {
  const opts = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s+(--?[a-zA-Z][\w-]*)\s+(.*)$/.exec(raw);
    if (!m) continue;
    const name = m[1].replace(/^-+/, '');
    let rest = m[2];
    const inactive = /\[inactive\]/.test(rest);
    const cur = /\[([^\]]*)\]\s*$/.exec(rest);
    const current = cur && cur[1] !== 'inactive' ? cur[1] : null;
    rest = rest.replace(/\s*\[[^\]]*\]\s*$/, '').replace(/\s*\[[^\]]*\]\s*$/, '');
    const step = /\(in steps of ([\d.]+)\)/.exec(rest);
    rest = rest.replace(/\s*\(in steps of [\d.]+\)/, '').trim();
    const range = /^(-?[\d.]+)\.\.(-?[\d.]+)(dpi|mm|%|us|bit)?$/.exec(rest);
    if (range) {
      opts[name] = { range: { min: Number(range[1]), max: Number(range[2]), step: step ? Number(step[1]) : null }, unit: range[3] || null, current, inactive };
      continue;
    }
    if (rest.includes('|') || /^[\w .-]+$/.test(rest)) {
      const unitM = /(dpi|mm|%)$/.exec(rest);
      const unit = unitM ? unitM[1] : null;
      const values = (unit ? rest.slice(0, -unit.length) : rest).split('|').map((v) => v.trim()).filter(Boolean);
      opts[name] = { values, unit, current, inactive };
    }
  }
  return opts;
}

export function classifySource(name) {
  if (/duplex/i.test(name)) return 'duplex';
  if (/adf|feeder|automatic document|adf front|adf back/i.test(name)) return 'feeder';
  if (/flatbed|platen|normal|glass|document table/i.test(name)) return 'flatbed';
  return 'other';
}

function colorModesFrom(opt) {
  const map = {};
  for (const v of opt?.values || []) {
    if (/^color$|^colour$|24bit color/i.test(v)) map.color ??= v;
    else if (/gray|grey/i.test(v)) map.gray ??= v;
    else if (/lineart|binary|black ?& ?white|halftone/i.test(v)) map.bw ??= v;
  }
  return map;
}

/** Turn parsed options for one source into the unified source model. */
export function buildSource(sourceName, opts, index) {
  const kind = sourceName ? classifySource(sourceName) : 'flatbed';
  const modes = colorModesFrom(opts.mode);
  const colorModes = ['color', 'gray', 'bw'].filter((m) => modes[m]);
  const res = opts.resolution;
  let resolutions = [];
  if (res?.range) resolutions = { min: res.range.min, max: res.range.max, step: res.range.step || 1 };
  else if (res?.values) resolutions = res.values.map(Number).filter(Number.isFinite);
  const x = opts.x?.range;
  const y = opts.y?.range;
  if (!x || !y || opts.x.unit !== 'mm') return null;
  const maxArea = { widthMm: round1(x.max), heightMm: round1(y.max) };
  const pct = (o) => (o?.range && !o.inactive && (o.unit === null || o.unit === '%') ? { min: o.range.min, max: o.range.max, step: o.range.step || 1 } : null);
  const def = Number(res?.current);
  return {
    id: kind === 'other' ? `source-${index}` : kind,
    kind,
    label: sourceName || 'Default source',
    duplex: kind === 'duplex',
    saneSource: sourceName,
    saneModes: modes,
    colorModes: colorModes.length ? colorModes : ['color'],
    resolutions,
    defaultResolution: Number.isFinite(def) ? def : Array.isArray(resolutions) ? resolutions[0] : resolutions.min,
    maxArea,
    minArea: null,
    customArea: true,
    paperSizes: paperSizesFor(maxArea),
    brightness: pct(opts.brightness),
    contrast: pct(opts.contrast),
  };
}

/** Map scanimage stderr text to an error code. */
export function mapSaneError(stderr, pagesSoFar = 0) {
  const s = stderr.toLowerCase();
  if (s.includes('out of documents') || s.includes('no more documents') || s.includes('document feeder out')) {
    return pagesSoFar > 0 ? null : new AgentError('FEEDER_EMPTY', 'The document feeder is empty.');
  }
  const table = [
    ['jammed', 'PAPER_JAM'],
    ['cover', 'COVER_OPEN'],
    ['device busy', 'DEVICE_BUSY'],
    ['access to resource has been denied', 'PERMISSION_DENIED'],
    ['permission denied', 'PERMISSION_DENIED'],
    ['invalid argument', 'UNSUPPORTED_SETTING'],
    ['out of memory', 'OUT_OF_MEMORY'],
    ['no space left', 'DISK_FULL'],
    ['error during device i/o', 'DEVICE_OFFLINE'],
    ['no scanners were identified', 'NO_DEVICES'],
    ['open of device', 'DEVICE_OPEN_FAILED'],
    ['operation was cancelled', 'SCAN_CANCELLED'],
  ];
  for (const [needle, code] of table) if (s.includes(needle)) return new AgentError(code, `Scanner reported: ${needle}.`);
  return new AgentError('DRIVER_ERROR', 'scanimage failed.', { stderr: stderr.slice(0, 300) });
}

export class SaneAdapter {
  constructor({ scanimage = 'scanimage', timeoutMs = 600_000 } = {}) {
    this.name = 'sane';
    this.bin = scanimage;
    this.timeoutMs = timeoutMs;
    this.capsCache = new Map();
  }

  async isAvailable() {
    if (process.platform === 'win32') return { available: false, reason: 'SANE is not available on Windows.' };
    try {
      const r = await runProcess(this.bin, ['--version'], { timeoutMs: 10_000 });
      return r.code === 0 ? { available: true } : { available: false, reason: 'scanimage --version failed.' };
    } catch {
      return { available: false, reason: 'scanimage (sane-utils) is not installed.' };
    }
  }

  async listDevices() {
    const r = await runProcess(this.bin, ['-L'], { timeoutMs: 60_000 }).catch(() => {
      throw new AgentError('DRIVER_MISSING', 'scanimage (sane-utils) is not installed.');
    });
    return parseDeviceList(r.lines.join('\n')).map((d) => ({ id: `sane:${d.id}`, name: d.description, manufacturer: d.description.split(' ')[0] || '', adapter: this.name, simulated: false, status: 'unknown' }));
  }

  async options(dev, source) {
    const args = ['-d', dev, ...(source ? ['--source', source] : []), '-A'];
    const r = await runProcess(this.bin, args, { timeoutMs: 45_000 });
    if (r.code !== 0) throw mapSaneError(r.stderr) || new AgentError('DRIVER_ERROR', 'scanimage failed.');
    return parseOptions(r.lines.join('\n'));
  }

  async getCapabilities(deviceId) {
    const cached = this.capsCache.get(deviceId);
    if (cached && cached.at > Date.now() - 60_000) return cached.caps;
    const dev = nativeId(deviceId);
    const base = await this.options(dev);
    const sourceNames = base.source?.values?.length ? base.source.values : [null];
    const sources = [];
    const seen = new Set();
    for (const [i, name] of sourceNames.entries()) {
      const opts = name && name !== base.source?.current ? await this.options(dev, name) : base;
      const src = buildSource(name, opts, i);
      if (!src) continue;
      if (seen.has(src.id)) src.id = `${src.id}-${i}`;
      seen.add(src.id);
      sources.push(src);
    }
    if (!sources.length) throw new AgentError('UNSUPPORTED_FEATURE', 'The SANE backend exposes no usable scan source.');
    const caps = {
      device: { id: deviceId, name: dev, adapter: this.name, simulated: false },
      status: { state: 'unknown', reportedByDriver: false },
      sources,
      notes: ['SANE via scanimage. Cover/jam state is only known when a scan fails.'],
    };
    this.capsCache.set(deviceId, { at: Date.now(), caps });
    return caps;
  }

  async scan(deviceId, settings, ctx) {
    const caps = await this.getCapabilities(deviceId);
    const source = caps.sources.find((s) => s.id === settings.source);
    await mkdir(ctx.outDir, { recursive: true });
    const args = ['-d', nativeId(deviceId), '--format=png', `--resolution=${settings.resolution}`, '-l', '0', '-t', '0', '-x', String(settings.area.widthMm), '-y', String(settings.area.heightMm)];
    if (source.saneSource) args.push('--source', source.saneSource);
    if (source.saneModes[settings.colorMode]) args.push('--mode', source.saneModes[settings.colorMode]);
    if (settings.brightness !== undefined) args.push(`--brightness=${settings.brightness}`);
    if (settings.contrast !== undefined) args.push(`--contrast=${settings.contrast}`);
    args.push(`--batch=${join(ctx.outDir, 'page-%04d.png')}`, '--batch-print', `--batch-count=${settings.maxPages}`);

    let pages = 0;
    let back = false;
    let chain = Promise.resolve();
    const r = await runProcess(this.bin, args, {
      timeoutMs: this.timeoutMs,
      signal: ctx.signal,
      onLine: (line) => {
        if (!line.endsWith('.png')) return;
        pages++;
        ctx.onProgress?.({ stage: 'scanning', page: pages + 1 });
        const side = settings.sourceKind === 'duplex' ? (back ? 'back' : 'front') : settings.sourceKind === 'flatbed' ? null : 'front';
        back = !back;
        const file = line.trim();
        chain = chain.then(async () => {
          const info = imageInfo(await readFile(file));
          if (!info) throw new AgentError('IMAGE_READ_FAILED', 'Scanned image could not be read.');
          ctx.onPage({ file, mime: info.mime, width: info.width, height: info.height, dpi: settings.resolution, colorMode: settings.colorMode, side });
        });
      },
    });
    await chain;
    if (r.aborted) throw new AgentError('SCAN_CANCELLED', 'Scan was cancelled.');
    if (r.timedOut) throw new AgentError('SCAN_TIMEOUT', 'The scanner did not respond in time.');
    if (r.code !== 0) {
      const err = mapSaneError(r.stderr, pages);
      if (err) throw err;
    }
  }
}

function nativeId(deviceId) {
  if (!deviceId.startsWith('sane:')) throw new AgentError('DEVICE_NOT_FOUND', 'Scanner not found.');
  return deviceId.slice(5);
}
