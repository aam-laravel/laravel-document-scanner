import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AgentError, toAgentError } from './errors.js';
import { validateSettings } from './capabilities.js';

/**
 * Scan job lifecycle: queued → scanning → completed | failed | cancelled.
 * One active job per device (scanners are not safe for concurrent use).
 * Page images live only in a per-job temp directory and are deleted when the
 * job is deleted or expires.
 */
export class JobManager {
  constructor({ registry, config, logger }) {
    this.registry = registry;
    this.config = config;
    this.logger = logger;
    this.jobs = new Map();
    this.deviceLocks = new Map(); // deviceId -> jobId
    this.sweeper = setInterval(() => this.sweep().catch(() => {}), 60_000);
    this.sweeper.unref();
  }

  async init() {
    await mkdir(this.config.tempDir, { recursive: true, mode: 0o700 });
    // remove leftovers from a previous run (crash / reboot)
    for (const name of await readdir(this.config.tempDir).catch(() => [])) {
      if (/^[0-9a-f-]{36}$/.test(name)) await rm(join(this.config.tempDir, name), { recursive: true, force: true });
    }
  }

  async create(owner, deviceId, input, correlationId) {
    const adapter = this.registry.forDevice(deviceId);
    if (this.deviceLocks.has(deviceId)) {
      throw new AgentError('DEVICE_BUSY', 'Another scan is already running on this scanner.');
    }
    this.deviceLocks.set(deviceId, 'pending'); // reserve before any await
    let caps, settings;
    const id = randomUUID();
    const dir = join(this.config.tempDir, id);
    try {
      caps = await adapter.getCapabilities(deviceId);
      settings = validateSettings(caps, input, { maxPages: this.config.maxPagesPerJob });
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      this.deviceLocks.delete(deviceId);
      throw e;
    }
    const controller = new AbortController();
    const job = {
      id,
      owner,
      deviceId,
      correlationId,
      settings,
      state: 'scanning',
      pages: [],
      error: null,
      progress: { stage: 'starting', page: 1 },
      createdAt: new Date().toISOString(),
      finishedAt: null,
      dir,
      controller,
      simulated: Boolean(caps.device.simulated),
    };
    this.jobs.set(id, job);
    this.deviceLocks.set(deviceId, id);
    this.logger.info('scan started', { jobId: id, deviceId, correlationId, source: settings.source, dpi: settings.resolution, colorMode: settings.colorMode });

    adapter
      .scan(deviceId, settings, {
        outDir: dir,
        signal: controller.signal,
        onProgress: (p) => { job.progress = p; },
        onPage: (p) => {
          job.pages.push({ index: job.pages.length + 1, ...p });
        },
      })
      .then(() => {
        if (job.state === 'cancelled') return;
        if (!job.pages.length) throw new AgentError('IMAGE_READ_FAILED', 'The scanner returned no pages.');
        job.state = 'completed';
      })
      .catch((e) => {
        if (job.state === 'cancelled' || controller.signal.aborted) {
          job.state = 'cancelled';
          job.error = new AgentError('SCAN_CANCELLED', 'Scan was cancelled.').toJSON(correlationId);
          return;
        }
        const err = toAgentError(e);
        job.state = 'failed';
        job.error = err.toJSON(correlationId);
        this.logger.warning('scan failed', { jobId: id, correlationId, code: err.code, details: err.details, internal: e instanceof AgentError ? undefined : String(e?.message || e) });
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        job.progress = { stage: 'finished' };
        this.deviceLocks.delete(deviceId);
        this.logger.info('scan finished', { jobId: id, correlationId, state: job.state, pages: job.pages.length });
      });

    return job;
  }

  get(owner, id) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new AgentError('JOB_NOT_FOUND', 'Scan job not found.');
    return job;
  }

  cancel(owner, id) {
    const job = this.get(owner, id);
    if (job.state === 'scanning') {
      job.state = 'cancelled';
      job.controller.abort();
    }
    return job;
  }

  async delete(owner, id) {
    const job = this.get(owner, id);
    if (job.state === 'scanning') this.cancel(owner, id);
    this.jobs.delete(id);
    await rm(job.dir, { recursive: true, force: true });
  }

  page(owner, id, index) {
    const job = this.get(owner, id);
    const page = job.pages.find((p) => p.index === index);
    if (!page) throw new AgentError('NOT_FOUND', 'Page not found.');
    return page;
  }

  /** Public JSON view (no filesystem paths). */
  view(job) {
    return {
      id: job.id,
      deviceId: job.deviceId,
      state: job.state,
      simulated: job.simulated,
      settings: job.settings,
      progress: job.progress,
      pages: job.pages.map((p) => ({ index: p.index, mime: p.mime, width: p.width, height: p.height, dpi: p.dpi, colorMode: p.colorMode, side: p.side, url: `/v1/jobs/${job.id}/pages/${p.index}` })),
      error: job.error,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    };
  }

  async sweep() {
    const cutoff = Date.now() - this.config.jobTtlSeconds * 1000;
    for (const job of this.jobs.values()) {
      if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) {
        this.jobs.delete(job.id);
        await rm(job.dir, { recursive: true, force: true });
        this.logger.debug('expired job removed', { jobId: job.id });
      }
    }
  }

  async pageSize(page) {
    return (await stat(page.file)).size;
  }

  async shutdown() {
    clearInterval(this.sweeper);
    for (const job of this.jobs.values()) {
      job.controller.abort();
      await rm(job.dir, { recursive: true, force: true });
    }
    this.jobs.clear();
  }
}
