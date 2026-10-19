import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../src/server.js';
import { SimulatorAdapter } from '../src/adapters/simulator.js';
import { signPairingToken } from '../src/security.js';
import { Logger } from '../src/logger.js';
import { imageInfo } from '../src/image.js';

const ORIGIN = 'https://app.example.com';
const SECRET = 's'.repeat(48);
let agent, base, tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-test-'));
  const config = {
    host: '127.0.0.1',
    port: 0,
    pairingMode: 'signed',
    sites: [{ origin: ORIGIN, pairingSecret: SECRET }],
    sessionTtlSeconds: 600,
    jobTtlSeconds: 600,
    scanTimeoutSeconds: 30,
    maxPagesPerJob: 10,
    maxRequestsPerMinute: 10_000,
    tempDir,
  };
  agent = createAgent(config, {
    adapters: [new SimulatorAdapter({ pageDelayMs: 40, feederSheets: 2 })],
    logger: new Logger({ level: 'error', file: null, console: false }),
  });
  const port = await agent.start();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await agent.stop();
  rmSync(tempDir, { recursive: true, force: true });
});

const req = (path, { method = 'GET', body, session, origin = ORIGIN, headers = {} } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

async function pair() {
  const r = await req('/v1/pair', { method: 'POST', body: { token: signPairingToken(SECRET, ORIGIN) } });
  assert.equal(r.status, 200);
  return (await r.json()).session;
}

async function waitJob(session, id) {
  for (let i = 0; i < 200; i++) {
    const job = await (await req(`/v1/jobs/${id}`, { session })).json();
    if (job.state !== 'scanning') return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job did not finish');
}

let n = 0;
const rid = () => `req-${Date.now()}-${n++}`;

test('health works for allowed origin and for local tools without Origin', async () => {
  const r = await req('/v1/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  const body = await r.json();
  assert.equal(body.protocol, 1);
  assert.equal(body.simulator, true);
  assert.equal((await req('/v1/health', { origin: null })).status, 200);
});

test('foreign origins get no CORS headers and cannot pair', async () => {
  const r = await req('/v1/health', { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  const p = await req('/v1/pair', { method: 'POST', origin: 'https://evil.example', body: { token: signPairingToken(SECRET, 'https://evil.example') } });
  assert.equal(p.status, 403);
});

test('preflight answers Private Network Access for allowed origins only', async () => {
  const ok = await req('/v1/devices', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-private-network'), 'true');
  const bad = await req('/v1/devices', { method: 'OPTIONS', origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
});

test('DNS rebinding: wrong Host header is rejected', async () => {
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get(`${base}/v1/health`, { headers: { Host: 'evil.example', Origin: ORIGIN } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 403);
});

test('commands require a paired session', async () => {
  const r = await req('/v1/devices');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'PAIRING_REQUIRED');
});

test('lists simulated devices and per-source capabilities', async () => {
  const session = await pair();
  const { devices } = await (await req('/v1/devices', { session })).json();
  assert.deepEqual(devices.map((d) => d.id), ['sim:flatbed', 'sim:adf', 'sim:jam']);
  assert.ok(devices.every((d) => d.simulated));
  const caps = await (await req(`/v1/devices/${encodeURIComponent('sim:adf')}/capabilities`, { session })).json();
  assert.deepEqual(caps.sources.map((s) => s.id), ['flatbed', 'feeder', 'duplex']);
  assert.ok(caps.sources.every((s) => !('wiaSelect' in s)));
});

test('flatbed scan produces one page that can be downloaded and deleted', async () => {
  const session = await pair();
  const r = await req('/v1/jobs', { method: 'POST', session, body: { requestId: rid(), deviceId: 'sim:flatbed', settings: { source: 'flatbed', colorMode: 'gray', resolution: 75, paper: { id: 'a5' } } } });
  assert.equal(r.status, 202);
  const job = await waitJob(session, (await r.json()).id);
  assert.equal(job.state, 'completed');
  assert.equal(job.pages.length, 1);
  const img = await req(job.pages[0].url, { session });
  assert.equal(img.headers.get('content-type'), 'image/png');
  const info = imageInfo(Buffer.from(await img.arrayBuffer()));
  assert.equal(info.width, Math.round((148 / 25.4) * 75));
  assert.equal((await req(`/v1/jobs/${job.id}`, { method: 'DELETE', session })).status, 204);
  assert.equal((await req(`/v1/jobs/${job.id}`, { session })).status, 404);
  assert.ok(!existsSync(join(tempDir, job.id)), 'temp files removed');
});

test('duplex feeder scan returns front/back pages for each sheet', async () => {
  const session = await pair();
  const r = await req('/v1/jobs', { method: 'POST', session, body: { requestId: rid(), deviceId: 'sim:adf', settings: { source: 'duplex', colorMode: 'color', resolution: 100, paper: { id: 'a5' } } } });
  const job = await waitJob(session, (await r.json()).id);
  assert.equal(job.state, 'completed');
  assert.deepEqual(job.pages.map((p) => p.side), ['front', 'back', 'front', 'back']);
});

test('paper jam fails the job but keeps pages scanned before it', async () => {
  const session = await pair();
  const r = await req('/v1/jobs', { method: 'POST', session, body: { requestId: rid(), deviceId: 'sim:jam', settings: { source: 'feeder', colorMode: 'bw', resolution: 100, paper: { id: 'a5' } } } });
  const job = await waitJob(session, (await r.json()).id);
  assert.equal(job.state, 'failed');
  assert.equal(job.error.code, 'PAPER_JAM');
  assert.equal(job.error.action, 'clear_jam');
  assert.equal(job.pages.length, 1);
});

test('cancel stops a running scan; device busy while scanning', async () => {
  const session = await pair();
  const r = await req('/v1/jobs', { method: 'POST', session, body: { requestId: rid(), deviceId: 'sim:adf', settings: { source: 'feeder', resolution: 100, paper: { id: 'a6' } } } });
  const { id } = await r.json();
  const busy = await req('/v1/jobs', { method: 'POST', session, body: { requestId: rid(), deviceId: 'sim:adf', settings: { source: 'feeder', resolution: 100 } } });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error.code, 'DEVICE_BUSY');
  const c = await req(`/v1/jobs/${id}/cancel`, { method: 'POST', session, body: { requestId: rid() } });
  assert.equal(c.status, 200);
  const job = await waitJob(session, id);
  assert.equal(job.state, 'cancelled');
  assert.equal(job.error.code, 'SCAN_CANCELLED');
});

test('unsupported settings and replayed requests are rejected', async () => {
  const session = await pair();
  const bad = await req('/v1/jobs', { method: 'POST', session, body: { requestId: rid(), deviceId: 'sim:adf', settings: { source: 'feeder', colorMode: 'bw' } } });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, 'UNSUPPORTED_SETTING');
  const id = rid();
  await req('/v1/jobs', { method: 'POST', session, body: { requestId: id, deviceId: 'sim:flatbed', settings: { source: 'film' } } });
  const replay = await req('/v1/jobs', { method: 'POST', session, body: { requestId: id, deviceId: 'sim:flatbed', settings: { source: 'flatbed' } } });
  assert.equal((await replay.json()).error.code, 'REPLAYED_REQUEST');
});

test('jobs are private to the session that created them', async () => {
  const a = await pair();
  const b = await pair();
  const r = await req('/v1/jobs', { method: 'POST', session: a, body: { requestId: rid(), deviceId: 'sim:flatbed', settings: { source: 'flatbed', resolution: 75, paper: { id: 'a6' } } } });
  const { id } = await r.json();
  await waitJob(a, id);
  assert.equal((await req(`/v1/jobs/${id}`, { session: b })).status, 404);
  assert.equal((await req(`/v1/jobs/${id}/pages/1`, { session: b })).status, 404);
});

test('status page is only served to top-level navigation and is not frameable', async () => {
  const r = await req('/', { origin: null });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const fromSite = await req('/', { origin: ORIGIN });
  assert.equal(fromSite.status, 404);
});

test('diagnostics are redacted', async () => {
  const session = await pair();
  const d = await (await req('/v1/diagnostics', { session })).json();
  assert.equal(JSON.stringify(d).includes(SECRET), false);
  assert.equal(d.devices.length, 3);
});
