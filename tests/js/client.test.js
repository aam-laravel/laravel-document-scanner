import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildPdf, verifyPdf, pdfString } from '../../resources/dist/pdf-writer.js';
import { PageStore } from '../../resources/dist/page-store.js';
import { AgentClient, compareVersions } from '../../resources/dist/agent-client.js';
import { Uploader, errorForResponse } from '../../resources/dist/uploader.js';
import { analyseBlank, convertPixels } from '../../resources/dist/image-tools.js';
import { resolutionChoices, formatBytes } from '../../resources/dist/scanner-app.js';

const JPEG = new Uint8Array(readFileSync(new URL('../Fixtures/tiny.jpg', import.meta.url)));

/* ---------- PDF ---------- */

test('buildPdf creates a structurally valid multi-page PDF with physical page sizes', () => {
  const pages = [
    { jpeg: JPEG, width: 40, height: 60, dpi: 72 },
    { jpeg: JPEG, width: 40, height: 60, dpi: 144 },
    { jpeg: JPEG, width: 60, height: 40, dpi: 72 },
  ];
  const bytes = buildPdf(pages, { title: 'مستند', date: new Date('2026-10-19T00:00:00Z') });
  assert.equal(verifyPdf(bytes, 3), 3);
  const text = Buffer.from(bytes).toString('latin1');
  assert.match(text, /\/MediaBox \[0 0 40 60\]/);
  assert.match(text, /\/MediaBox \[0 0 20 30\]/, '144 dpi halves the point size');
  assert.match(text, /\/MediaBox \[0 0 60 40\]/, 'mixed page sizes and orientations');
  assert.match(text, /\/Title <FEFF/, 'non-ASCII title is UTF-16BE');
  assert.ok(!text.includes('/ObjStm'));
  // fixture consumed by the PHP PdfInspector tests (cross-implementation check)
  writeFileSync(new URL('../Fixtures/generated-3-pages.pdf', import.meta.url), bytes);
});

test('buildPdf rejects empty input and non-JPEG data; verifyPdf detects mismatches', () => {
  assert.throws(() => buildPdf([]), /NO_PAGES/);
  assert.throws(() => buildPdf([{ jpeg: new Uint8Array([1, 2, 3]), width: 1, height: 1, dpi: 72 }]), /not JPEG/);
  const bytes = buildPdf([{ jpeg: JPEG, width: 40, height: 60, dpi: 72 }]);
  assert.throws(() => verifyPdf(bytes, 2), /PDF_PAGE_MISMATCH/);
  const truncated = bytes.slice(0, bytes.length - 20);
  assert.throws(() => verifyPdf(truncated));
});

test('pdfString escapes literal strings', () => {
  assert.equal(pdfString('a(b)\\'), '(a\\(b\\)\\\\)');
});

/* ---------- pages ---------- */

const fakeUrls = () => {
  const live = new Set();
  let n = 0;
  return { live, createUrl: () => { const u = `blob:${++n}`; live.add(u); return u; }, revokeUrl: (u) => live.delete(u) };
};

test('PageStore add / move / rotate / remove / version and URL lifecycle', () => {
  const urls = fakeUrls();
  const s = new PageStore(urls);
  const a = s.add({ blob: { size: 10 }, status: 'ready' });
  const b = s.add({ blob: { size: 20 }, status: 'ready' });
  const c = s.add({ status: 'processing' }, 0);
  assert.deepEqual(s.pages.map((p) => p.id), [c.id, a.id, b.id]);
  const v = s.version;
  s.move(b.id, -2);
  assert.deepEqual(s.pages.map((p) => p.id), [b.id, c.id, a.id]);
  assert.ok(s.version > v);
  assert.equal(s.rotate(a.id, -90).rotation, 270);
  assert.equal(s.rotate(a.id, 450).rotation, 0);
  assert.equal(s.totalBytes(), 30);
  assert.equal(s.ready().length, 2);
  s.update(c.id, { blob: { size: 5 }, status: 'ready' });
  assert.equal(urls.live.size, 3);
  s.remove(a.id);
  assert.equal(urls.live.size, 2);
  s.moveTo(c.id, 99);
  assert.equal(s.pages.at(-1).id, c.id);
  s.clear();
  assert.equal(urls.live.size, 0, 'object URLs revoked');
  assert.equal(s.length, 0);
});

/* ---------- image helpers ---------- */

test('blank detection and software colour conversion', () => {
  const w = 50;
  const h = 50;
  const white = new Uint8ClampedArray(w * h * 4).fill(255);
  assert.equal(analyseBlank(white, w, h).blank, true);
  const text = new Uint8ClampedArray(white);
  for (let y = 20; y < 30; y++) for (let x = 10; x < 40; x++) text.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  assert.equal(analyseBlank(text, w, h).blank, false);
  const px = convertPixels(new Uint8ClampedArray([200, 100, 50, 255]), 'bw');
  assert.deepEqual([...px], [0, 0, 0, 255]);
});

test('resolution choices honour device lists, ranges and the max dpi policy', () => {
  assert.deepEqual(resolutionChoices([75, 150, 300, 600, 1200], 600), [75, 150, 300, 600]);
  assert.deepEqual(resolutionChoices({ min: 50, max: 300, step: 50 }, 600), [100, 150, 200, 300]);
  assert.deepEqual(resolutionChoices([300], 600), [300]);
  assert.equal(formatBytes(1536, 'en'), '1.5 KB');
});

/* ---------- agent client ---------- */

function mockFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) return handler(url, init);
    }
    throw new TypeError('Failed to fetch');
  };
  f.calls = calls;
  return f;
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, blob: async () => new Blob(['x']) });

test('probe: connected / incompatible / origin blocked / not running', async () => {
  const ok = new AgentClient({ url: 'http://127.0.0.1:1', fetch: mockFetch([[/health/, () => json(200, { version: '1.2.0', protocol: 1 })]]) });
  assert.equal((await ok.probe()).state, 'connected');

  const old = new AgentClient({ url: 'http://127.0.0.1:1', minVersion: '1.3.0', fetch: mockFetch([[/health/, () => json(200, { version: '1.2.9', protocol: 1 })]]) });
  const r = await old.probe();
  assert.equal(r.state, 'incompatible');
  assert.equal(r.error.code, 'AGENT_INCOMPATIBLE');

  const proto = new AgentClient({ url: 'http://127.0.0.1:1', fetch: mockFetch([[/health/, () => json(200, { version: '9.0.0', protocol: 2 })]]) });
  assert.equal((await proto.probe()).state, 'incompatible');

  // CORS rejection throws in normal mode, but the no-cors probe resolves
  const blocked = new AgentClient({ url: 'http://127.0.0.1:1', fetch: async (u, init) => { if (init.mode === 'no-cors') return { ok: false, status: 0 }; throw new TypeError('cors'); } });
  assert.equal((await blocked.probe()).state, 'origin_blocked');

  const down = new AgentClient({ url: 'http://127.0.0.1:1', fetch: async () => { throw new TypeError('refused'); } });
  const d = await down.probe();
  assert.equal(d.state, 'not_running');
  assert.equal(d.error.code, 'AGENT_UNREACHABLE');
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
});

test('signed pairing, bearer auth, automatic re-pair on expired session, error mapping', async () => {
  let sessions = 0;
  let deviceCalls = 0;
  const f = mockFetch([
    [/\/v1\/pair$/, (u, init) => { assert.equal(JSON.parse(init.body).token, 'tok'); return json(200, { session: `sess-${++sessions}` }); }],
    [/\/v1\/devices$/, (u, init) => {
      deviceCalls++;
      if (deviceCalls === 1) return json(401, { error: { code: 'SESSION_EXPIRED', message: 'x' } });
      assert.equal(init.headers.Authorization, 'Bearer sess-2');
      return json(200, { devices: [{ id: 'sim:flatbed' }], problems: [] });
    }],
    [/\/v1\/jobs$/, () => json(409, { error: { code: 'DEVICE_BUSY', message: 'busy', action: 'wait_retry', correlationId: 'abc12345' } })],
  ]);
  const c = new AgentClient({ url: 'http://127.0.0.1:1', fetch: f });
  await assert.rejects(c.devices(), { code: 'PAIRING_REQUIRED' });
  await c.pairSigned(async () => ({ token: 'tok' }));
  const r = await c.devices();
  assert.equal(r.devices.length, 1);
  assert.equal(sessions, 2, 're-paired once');
  await assert.rejects(c.startJob('sim:flatbed', {}), (e) => e.code === 'DEVICE_BUSY' && e.action === 'wait_retry' && e.status === 409);
  const job = f.calls.find((x) => x.url.endsWith('/v1/jobs'));
  assert.match(JSON.parse(job.init.body).requestId, /^[0-9a-f-]{36}$/, 'unique requestId per command');
});

test('runJob delivers pages incrementally and keeps pages of a failed job', async () => {
  const states = [
    { id: 'j', state: 'scanning', pages: [{ index: 1, url: '/v1/jobs/00000000-0000-0000-0000-000000000000/pages/1' }] },
    { id: 'j', state: 'failed', pages: [{ index: 1, url: '/v1/jobs/00000000-0000-0000-0000-000000000000/pages/1' }], error: { code: 'PAPER_JAM' } },
  ];
  let poll = 0;
  const c = new AgentClient({
    url: 'http://127.0.0.1:1',
    fetch: mockFetch([
      [/\/v1\/jobs$/, () => json(202, states[0])],
      [/\/v1\/jobs\/j$/, () => json(200, states[Math.min(++poll, 1)])],
    ]),
  });
  c.session = 's'.repeat(30);
  const got = [];
  const job = await c.runJob('sim:jam', {}, { pollMs: 1, onPage: (j, p) => got.push(p.index) });
  assert.equal(job.state, 'failed');
  assert.deepEqual(got, [1], 'page delivered exactly once');
});

/* ---------- uploader ---------- */

class FakeXhr {
  static next = null;
  constructor() { this.headers = {}; this.upload = {}; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  send(body) {
    this.body = body;
    const { status, response, network } = FakeXhr.next;
    FakeXhr.last = this;
    queueMicrotask(() => {
      if (network) return this.onerror();
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.status = status;
      this.responseText = JSON.stringify(response);
      this.onload();
    });
  }
}

function uploaderWith(sessionResponses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === '/sessions') return json(201, sessionResponses.shift());
    if (url.endsWith('/preflight')) return json(200, { ok: true });
    throw new TypeError('unexpected');
  };
  return { up: new Uploader({ endpoints: { sessions: '/sessions', token: '/token' }, csrfToken: 'csrf', fetch: fetchImpl, xhr: () => new FakeXhr() }), calls };
}

const session = (id) => ({ id, status: 'open', expiresAt: new Date(Date.now() + 3600e3).toISOString(), uploadUrl: `/s/${id}/upload`, preflightUrl: `/s/${id}/preflight`, cancelUrl: `/s/${id}` });

test('upload sends CSRF + correlation headers, reports progress, and reuses the session on retry', async () => {
  const { up, calls } = uploaderWith([session('A')]);
  const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });

  FakeXhr.next = { network: true };
  await assert.rejects(up.upload(blob, { filename: 'x.pdf', pages: 1 }), { code: 'NETWORK_ERROR' });
  assert.equal(FakeXhr.last.headers['X-CSRF-TOKEN'], 'csrf');
  assert.match(FakeXhr.last.headers['X-Correlation-Id'], /^[0-9a-f-]{36}$/);

  FakeXhr.next = { status: 201, response: { document: { id: 'D1', pages: 1, size: 8 }, session: { ...session('A'), status: 'completed' }, duplicate: false } };
  const progress = [];
  const r = await up.upload(blob, { filename: 'x.pdf', pages: 1, onProgress: (f) => progress.push(f) });
  assert.equal(r.document.id, 'D1');
  assert.deepEqual(progress, [0.5]);
  assert.equal(calls.filter((c) => c.url === '/sessions').length, 1, 'retry reused the same server session (idempotency)');
  assert.equal(FakeXhr.last.url, '/s/A/upload');
});

test('upload never reports success without a stored document; maps HTTP errors', async () => {
  const { up } = uploaderWith([session('B')]);
  const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
  FakeXhr.next = { status: 200, response: { ok: true } };
  await assert.rejects(up.upload(blob, {}), { code: 'UPLOAD_FAILED' });
  FakeXhr.next = { status: 422, response: { error: { code: 'FILE_CORRUPT', message: 'bad' } } };
  await assert.rejects(up.upload(blob, {}), { code: 'FILE_CORRUPT' });
  assert.equal(errorForResponse(419, null).code, 'CSRF_MISMATCH');
  assert.equal(errorForResponse(401, { message: 'Unauthenticated.' }).code, 'UNAUTHENTICATED');
  assert.equal(errorForResponse(0, null).code, 'NETWORK_ERROR');
  assert.equal(errorForResponse(500, null).code, 'UPLOAD_FAILED');
});
