import http from 'node:http';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AgentError, toAgentError } from './errors.js';
import { SecurityContext, isAllowedHost } from './security.js';
import { JobManager } from './jobs.js';
import { AdapterRegistry, createAdapters } from './adapters/index.js';
import { Logger } from './logger.js';
import { VERSION, PROTOCOL, BUILD_DATE, AGENT_NAME } from './version.js';

const MAX_BODY = 16 * 1024;
const CORRELATION = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Loopback HTTP API consumed by the browser client. Every request is checked
 * for: loopback Host header (DNS rebinding), allow-listed Origin (CORS + PNA),
 * rate limit, then a bearer session obtained through pairing.
 */
export function createAgent(config, { adapters, logger } = {}) {
  logger ??= new Logger({ level: config.logLevel, file: config.logFile });
  const registry = new AdapterRegistry(adapters ?? createAdapters(config), logger);
  const security = new SecurityContext(config);
  const jobs = new JobManager({ registry, config, logger });
  const startedAt = new Date().toISOString();

  const routes = [
    ['GET', /^\/v1\/health$/, health, { auth: false, originOptional: true }],
    ['POST', /^\/v1\/pair$/, pairSigned, { auth: false }],
    ['POST', /^\/v1\/pair\/request$/, pairRequest, { auth: false }],
    ['POST', /^\/v1\/pair\/confirm$/, pairConfirm, { auth: false }],
    ['DELETE', /^\/v1\/session$/, endSession, {}],
    ['GET', /^\/v1\/devices$/, listDevices, {}],
    ['GET', /^\/v1\/devices\/([^/]+)\/capabilities$/, capabilities, {}],
    ['POST', /^\/v1\/jobs$/, createJob, {}],
    ['GET', /^\/v1\/jobs\/([0-9a-f-]{36})$/, getJob, {}],
    ['POST', /^\/v1\/jobs\/([0-9a-f-]{36})\/cancel$/, cancelJob, {}],
    ['DELETE', /^\/v1\/jobs\/([0-9a-f-]{36})$/, deleteJob, {}],
    ['GET', /^\/v1\/jobs\/([0-9a-f-]{36})\/pages\/(\d{1,4})$/, getPage, {}],
    ['GET', /^\/v1\/diagnostics$/, diagnostics, {}],
  ];

  function healthBody() {
    return {
      name: AGENT_NAME,
      version: VERSION,
      protocol: PROTOCOL,
      buildDate: BUILD_DATE,
      pairingMode: config.pairingMode,
      adapters: registry.adapters.map((a) => a.name),
      simulator: registry.adapters.some((a) => a.name === 'simulator'),
      platform: process.platform,
    };
  }

  async function health() {
    return { status: 200, body: { ...healthBody(), adapterStatus: await registry.status() } };
  }

  async function pairSigned(ctx) {
    security.rateLimit(`pair:${ctx.origin}`, 20);
    const body = await ctx.json();
    return { status: 200, body: security.pairSigned(ctx.origin, body.token) };
  }

  async function pairRequest(ctx) {
    security.rateLimit(`pair:${ctx.origin}`, 10);
    const { requestId, expiresAt } = security.requestPairingCode(ctx.origin);
    logger.info('pairing code requested; open the agent status page to read it', { origin: ctx.origin, url: `http://127.0.0.1:${config.port}/` });
    return { status: 200, body: { requestId, expiresAt, codeLocation: `http://127.0.0.1:${config.port}/` } };
  }

  async function pairConfirm(ctx) {
    security.rateLimit(`pair:${ctx.origin}`, 10);
    const body = await ctx.json();
    return { status: 200, body: security.confirmPairingCode(ctx.origin, body.requestId, body.code) };
  }

  async function endSession(ctx) {
    security.revoke(ctx.session);
    return { status: 204 };
  }

  async function listDevices() {
    const { devices, problems } = await registry.listDevices();
    return { status: 200, body: { devices: devices.map((d) => ({ ...d, busy: jobs.deviceLocks.has(d.id) })), problems } };
  }

  async function capabilities(ctx, [id]) {
    const deviceId = decodeURIComponent(id);
    const caps = await registry.forDevice(deviceId).getCapabilities(deviceId);
    const busy = jobs.deviceLocks.has(deviceId);
    return { status: 200, body: { ...caps, status: { ...caps.status, state: busy ? 'busy' : caps.status.state }, sources: caps.sources.map(publicSource) } };
  }

  async function createJob(ctx) {
    const body = await ctx.json();
    security.consumeRequestId(ctx.session, body.requestId);
    if (typeof body.deviceId !== 'string') throw new AgentError('INVALID_REQUEST', 'deviceId is required.');
    const job = await jobs.create(ctx.session, body.deviceId, body.settings, ctx.correlationId);
    return { status: 202, body: jobs.view(job) };
  }

  async function getJob(ctx, [id]) {
    return { status: 200, body: jobs.view(jobs.get(ctx.session, id)) };
  }

  async function cancelJob(ctx, [id]) {
    const body = await ctx.json();
    security.consumeRequestId(ctx.session, body.requestId);
    return { status: 200, body: jobs.view(jobs.cancel(ctx.session, id)) };
  }

  async function deleteJob(ctx, [id]) {
    await jobs.delete(ctx.session, id);
    return { status: 204 };
  }

  async function getPage(ctx, [id, n]) {
    const page = jobs.page(ctx.session, id, Number(n));
    return { status: 200, file: page.file, mime: page.mime, size: await jobs.pageSize(page) };
  }

  async function diagnostics() {
    const { devices, problems } = await registry.listDevices();
    return {
      status: 200,
      body: {
        ...healthBody(),
        startedAt,
        os: { platform: process.platform, release: os.release(), arch: process.arch },
        node: process.version,
        adapterStatus: await registry.status(),
        devices: devices.map((d) => ({ id: d.id, name: d.name, adapter: d.adapter, simulated: d.simulated })),
        problems,
        activeJobs: [...jobs.jobs.values()].filter((j) => j.state === 'scanning').length,
        recentErrors: logger.recent.slice(-20),
        limits: { maxPagesPerJob: config.maxPagesPerJob, scanTimeoutSeconds: config.scanTimeoutSeconds },
      },
    };
  }

  function corsHeaders(req, origin) {
    const h = {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Correlation-Id',
      'Access-Control-Expose-Headers': 'X-Correlation-Id, Content-Length',
      'Access-Control-Max-Age': '600',
    };
    // Private Network Access / Local Network Access preflight (Chromium)
    if (req.headers['access-control-request-private-network'] === 'true') h['Access-Control-Allow-Private-Network'] = 'true';
    return h;
  }

  function send(res, status, body, headers = {}) {
    const base = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers };
    if (status === 204 || body === undefined) {
      res.writeHead(status, base).end();
      return;
    }
    const data = JSON.stringify(body);
    res.writeHead(status, { ...base, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) }).end(data);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (req.method === 'GET' || req.method === 'DELETE') return resolve({});
      const type = req.headers['content-type'] || '';
      if (!type.startsWith('application/json')) return reject(new AgentError('INVALID_REQUEST', 'Content-Type must be application/json.'));
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new AgentError('PAYLOAD_TOO_LARGE', 'Request body too large.'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          resolve(parsed && typeof parsed === 'object' ? parsed : {});
        } catch {
          reject(new AgentError('INVALID_REQUEST', 'Malformed JSON.'));
        }
      });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const correlationId = CORRELATION.test(req.headers['x-correlation-id'] || '') ? req.headers['x-correlation-id'] : randomUUID();
    const origin = req.headers.origin;
    const url = new URL(req.url, `http://127.0.0.1:${config.port}`);
    let cors = {};
    try {
      if (!isAllowedHost(req.headers.host, config.port)) throw new AgentError('HOST_NOT_ALLOWED', 'Host header not allowed.');

      if (!origin && req.method === 'GET' && url.pathname === '/') return statusPage(res);

      const allowed = origin && security.isAllowedOrigin(origin);
      if (allowed) cors = corsHeaders(req, origin);
      if (req.method === 'OPTIONS') {
        if (!allowed) throw new AgentError('ORIGIN_NOT_ALLOWED', 'Origin is not allowed.');
        return send(res, 204, undefined, cors);
      }

      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!route) throw new AgentError('NOT_FOUND', 'Unknown endpoint.');
      const [, re, fn, opts] = route;
      if (!allowed && !(opts.originOptional && !origin)) throw new AgentError('ORIGIN_NOT_ALLOWED', 'Origin is not allowed.');

      security.rateLimit(`req:${origin || 'local'}`);
      const ctx = { req, origin, correlationId, json: () => readJson(req) };
      if (opts.auth !== false) ctx.session = security.authenticate(origin, req.headers.authorization);

      const result = await fn(ctx, re.exec(url.pathname).slice(1));
      const headers = { ...cors, 'X-Correlation-Id': correlationId };
      if (result.file) {
        res.writeHead(200, { ...headers, 'Content-Type': result.mime, 'Content-Length': result.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        createReadStream(result.file).on('error', () => res.destroy()).pipe(res);
        return;
      }
      send(res, result.status, result.body, headers);
    } catch (e) {
      const err = toAgentError(e);
      if (err.code === 'INTERNAL_ERROR') logger.error('request failed', { path: url.pathname, correlationId, error: String(e?.stack || e) });
      else if (err.status >= 400 && !['PAIRING_REQUIRED', 'NOT_FOUND'].includes(err.code)) logger.debug('request rejected', { path: url.pathname, code: err.code, correlationId });
      send(res, err.status, { error: err.toJSON(correlationId) }, { ...cors, 'X-Correlation-Id': correlationId });
    }
  }

  /** Human-facing page for the local user only (shows pairing codes in "code" mode). */
  function statusPage(res) {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const codes = security.pendingCodes();
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Document Scanner Agent</title>
<style>body{font:15px system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1f2937}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}.code{font-size:40px;letter-spacing:8px;font-weight:700}</style></head><body>
<h1>Document Scanner Agent</h1>
<p>Version <code>${esc(VERSION)}</code> · protocol <code>${PROTOCOL}</code> · build <code>${esc(BUILD_DATE)}</code> · adapters <code>${esc(registry.adapters.map((a) => a.name).join(', '))}</code></p>
<p>Allowed sites: ${config.sites.map((s) => `<code>${esc(s.origin)}</code>`).join(' ') || '<em>none configured</em>'}</p>
${config.pairingMode === 'code' ? (codes.length ? codes.map((c) => `<p>Pairing code for <code>${esc(c.origin)}</code>:</p><p class="code">${esc(c.code)}</p>`).join('') : '<p>No pending pairing request.</p>') : '<p>Pairing mode: signed tokens from the web application.</p>'}
</body></html>`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    }).end(html);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  return {
    server,
    security,
    jobs,
    registry,
    logger,
    async start() {
      await jobs.init();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
      });
      config.port = server.address().port; // tests listen on port 0
      logger.info('agent listening', { host: config.host, port: server.address().port, version: VERSION, adapters: registry.adapters.map((a) => a.name), pairingMode: config.pairingMode, sites: config.sites.map((s) => s.origin) });
      return server.address().port;
    },
    async stop() {
      await jobs.shutdown();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Strip adapter-internal fields before sending capabilities to the browser. */
function publicSource(s) {
  const { wiaSelect, saneSource, saneModes, winrtFormat, ...rest } = s;
  return rest;
}
