import { AgentError } from '../errors.js';
import { SimulatorAdapter } from './simulator.js';
import { WiaAdapter } from './wia.js';
import { SaneAdapter } from './sane.js';
import { WinRtAdapter } from './winrt.js';

/**
 * Resolve configured adapter names. "auto" picks the native backend for the OS
 * (Windows.Devices.Scanners on Windows, SANE on Linux). The simulator is never enabled implicitly.
 */
export function createAdapters(config, platform = process.platform) {
  const names = new Set();
  for (const n of config.adapters) {
    if (n === 'auto') {
      // Windows.Devices.Scanners returns every page of a feeder job; the WIA 1.0
      // Automation adapter ("wia") stays available for drivers it cannot use.
      if (platform === 'win32') names.add('winrt');
      else if (platform === 'linux') names.add('sane');
    } else names.add(n);
  }
  const timeoutMs = config.scanTimeoutSeconds * 1000;
  const list = [];
  for (const n of names) {
    if (n === 'simulator') list.push(new SimulatorAdapter(config.simulator));
    else if (n === 'winrt') list.push(new WinRtAdapter({ timeoutMs }));
    else if (n === 'wia') list.push(new WiaAdapter({ timeoutMs }));
    else if (n === 'sane') list.push(new SaneAdapter({ timeoutMs }));
    else throw new Error(`Unknown adapter "${n}" (use auto, winrt, wia, sane or simulator).`);
  }
  return list;
}

export class AdapterRegistry {
  constructor(adapters, logger) {
    this.adapters = adapters;
    this.logger = logger;
  }

  async status() {
    return Promise.all(this.adapters.map(async (a) => ({ name: a.name, ...(await a.isAvailable()) })));
  }

  /** List devices from all available adapters; adapter failures are reported, not fatal. */
  async listDevices() {
    const devices = [];
    const problems = [];
    for (const a of this.adapters) {
      const avail = await a.isAvailable();
      if (!avail.available) {
        problems.push({ adapter: a.name, code: 'ADAPTER_UNAVAILABLE', reason: avail.reason });
        continue;
      }
      try {
        devices.push(...(await a.listDevices()));
      } catch (e) {
        const err = e instanceof AgentError ? e : new AgentError('DRIVER_ERROR', 'Device enumeration failed.');
        this.logger?.warning('device enumeration failed', { adapter: a.name, code: err.code });
        problems.push({ adapter: a.name, code: err.code, reason: err.message });
      }
    }
    return { devices, problems };
  }

  forDevice(deviceId) {
    const prefix = deviceId.split(':')[0];
    const map = { sim: 'simulator', win: 'winrt', wia: 'wia', sane: 'sane' };
    const adapter = this.adapters.find((a) => a.name === map[prefix]);
    if (!adapter) throw new AgentError('DEVICE_NOT_FOUND', 'Scanner not found.', { deviceId });
    return adapter;
  }
}
