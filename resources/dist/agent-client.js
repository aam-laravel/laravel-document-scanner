import { ScannerError, fromErrorBody, toScannerError, uuid } from './errors.js';

/** Compare dotted versions numerically: returns -1, 0, 1. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Browser client for the local Scanner Agent (loopback HTTP, protocol v1).
 * The agent session token is kept in memory only.
 */
export class AgentClient {
  /**
   * @param {object} o
   * @param {string} o.url              agent base URL (http://127.0.0.1:47115)
   * @param {number} o.protocol         required protocol
   * @param {string} o.minVersion       minimum agent version
   * @param {number} [o.probeTimeoutMs]
   * @param {number} [o.requestTimeoutMs]
   * @param {Function} [o.fetch]
   */
  constructor({ url, protocol = 1, minVersion = '1.0.0', probeTimeoutMs = 2500, requestTimeoutMs = 20000, fetch: f }) {
    this.url = String(url).replace(/\/+$/, '');
    this.protocol = protocol;
    this.minVersion = minVersion;
    this.probeTimeoutMs = probeTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetch = f || globalThis.fetch.bind(globalThis);
    this.session = null;
    this.health = null;
    this.repair = null; // async () => void, set by pair()
  }

  /**
   * Determine agent state from the browser:
   *  connected | not_running | origin_blocked | incompatible
   * A CORS-blocked response and a refused connection both reject a normal
   * fetch; a `no-cors` probe still resolves when something is listening, which
   * separates "running but this site is not allowed" from "not running".
   */
  async probe() {
    try {
      const r = await this.fetch(`${this.url}/v1/health`, { signal: AbortSignal.timeout(this.probeTimeoutMs), cache: 'no-store' });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body) return { state: 'origin_blocked', error: fromErrorBody(body, r.status, 'ORIGIN_NOT_ALLOWED') };
      this.health = body;
      if (body.protocol !== this.protocol || compareVersions(body.version, this.minVersion) < 0) {
        return { state: 'incompatible', health: body, error: new ScannerError('AGENT_INCOMPATIBLE', 'Incompatible agent', { details: { version: body.version, protocol: body.protocol } }) };
      }
      return { state: 'connected', health: body };
    } catch {
      try {
        await this.fetch(`${this.url}/v1/health`, { mode: 'no-cors', signal: AbortSignal.timeout(this.probeTimeoutMs), cache: 'no-store' });
        return { state: 'origin_blocked', error: new ScannerError('ORIGIN_NOT_ALLOWED', 'Origin not allowed by agent') };
      } catch {
        return { state: 'not_running', error: new ScannerError('AGENT_UNREACHABLE', 'Agent unreachable') };
      }
    }
  }

  /** Signed pairing: `getToken` asks Laravel for a short-lived token. */
  async pairSigned(getToken) {
    const doPair = async () => {
      const { token } = await getToken();
      const body = await this.raw('POST', '/v1/pair', { token }, { auth: false });
      this.session = body.session;
    };
    await doPair();
    this.repair = doPair;
  }

  /** Code pairing step 1: the agent shows a code on its local page. */
  async requestPairingCode() {
    return this.raw('POST', '/v1/pair/request', {}, { auth: false });
  }

  /** Code pairing step 2. */
  async confirmPairingCode(requestId, code) {
    const body = await this.raw('POST', '/v1/pair/confirm', { requestId, code }, { auth: false });
    this.session = body.session;
    this.repair = null; // a code cannot be re-used; the UI asks again
  }

  /** Request with automatic single re-pair on an expired session (signed mode). */
  async request(method, path, body, opts = {}) {
    try {
      return await this.raw(method, path, body, opts);
    } catch (e) {
      if (this.repair && ['PAIRING_REQUIRED', 'SESSION_EXPIRED'].includes(e.code)) {
        await this.repair();
        return this.raw(method, path, body, opts);
      }
      throw e;
    }
  }

  async raw(method, path, body, { auth = true, blob = false, correlationId = uuid(), timeoutMs } = {}) {
    const headers = { 'X-Correlation-Id': correlationId };
    if (auth) {
      if (!this.session) throw new ScannerError('PAIRING_REQUIRED', 'Not paired', { correlationId });
      headers.Authorization = `Bearer ${this.session}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try {
      r = await this.fetch(this.url + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs || this.requestTimeoutMs),
        cache: 'no-store',
      });
    } catch (e) {
      const err = toScannerError(e, 'AGENT_UNREACHABLE');
      if (err.code === 'SCAN_CANCELLED') err.code = 'AGENT_UNREACHABLE';
      err.correlationId = correlationId;
      throw err;
    }
    if (!r.ok) {
      const data = await r.json().catch(() => null);
      const err = fromErrorBody(data, r.status, 'INTERNAL_ERROR');
      err.correlationId ??= correlationId;
      throw err;
    }
    if (r.status === 204) return null;
    return blob ? r.blob() : r.json();
  }

  devices() {
    return this.request('GET', '/v1/devices');
  }

  capabilities(deviceId) {
    return this.request('GET', `/v1/devices/${encodeURIComponent(deviceId)}/capabilities`, undefined, { timeoutMs: 60000 });
  }

  startJob(deviceId, settings, correlationId) {
    return this.request('POST', '/v1/jobs', { requestId: uuid(), deviceId, settings }, { correlationId, timeoutMs: 60000 });
  }

  job(id) {
    return this.request('GET', `/v1/jobs/${id}`);
  }

  cancelJob(id) {
    return this.request('POST', `/v1/jobs/${id}/cancel`, { requestId: uuid() });
  }

  deleteJob(id) {
    return this.request('DELETE', `/v1/jobs/${id}`);
  }

  pageBlob(job, page) {
    if (!/^\/v1\/jobs\/[0-9a-f-]{36}\/pages\/\d+$/.test(page.url)) throw new ScannerError('INVALID_REQUEST', 'Unexpected page URL');
    return this.request('GET', page.url, undefined, { blob: true, timeoutMs: 60000 });
  }

  diagnostics() {
    return this.request('GET', '/v1/diagnostics');
  }

  /**
   * Run a job to completion, invoking onPage for each page as soon as it is
   * available. Resolves with the final job; failed/cancelled jobs resolve too
   * (callers inspect job.state) so already-scanned pages are never lost.
   */
  async runJob(deviceId, settings, { onPage, onProgress, signal, pollMs = 400, timeoutMs = 600000, correlationId = uuid() } = {}) {
    let job = await this.startJob(deviceId, settings, correlationId);
    const seen = new Set();
    const started = Date.now();
    let cancelRequested = false;
    const deliver = async () => {
      for (const p of job.pages) {
        if (seen.has(p.index)) continue;
        seen.add(p.index);
        await onPage?.(job, p);
      }
    };
    for (;;) {
      await deliver();
      onProgress?.(job);
      if (job.state !== 'scanning') break;
      if (signal?.aborted && !cancelRequested) {
        cancelRequested = true;
        await this.cancelJob(job.id).catch(() => {});
      }
      if (Date.now() - started > timeoutMs && !cancelRequested) {
        cancelRequested = true;
        await this.cancelJob(job.id).catch(() => {});
        job.error = { code: 'SCAN_TIMEOUT' };
      }
      await new Promise((r) => setTimeout(r, pollMs));
      job = await this.job(job.id);
    }
    await deliver();
    return job;
  }
}
