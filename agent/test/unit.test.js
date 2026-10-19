import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SecurityContext, signPairingToken, isAllowedHost } from '../src/security.js';
import { normalizeOrigin, loadConfig } from '../src/config.js';
import { paperSizesFor, validateSettings, resolutionSupported } from '../src/capabilities.js';
import { buildCapabilities, mapWiaError } from '../src/adapters/wia.js';
import { parseDeviceList, parseOptions, buildSource, mapSaneError, classifySource } from '../src/adapters/sane.js';
import { Raster, imageInfo } from '../src/image.js';
import { redact } from '../src/logger.js';
import { AgentError } from '../src/errors.js';

const ORIGIN = 'https://app.example.com';
const SECRET = 'x'.repeat(40);
const cfg = (extra = {}) => ({ pairingMode: 'signed', sessionTtlSeconds: 60, maxRequestsPerMinute: 5, sites: [{ origin: ORIGIN, pairingSecret: SECRET }], ...extra });

test('signed pairing accepts a valid token once and binds the session to the origin', () => {
  const sec = new SecurityContext(cfg());
  const token = signPairingToken(SECRET, ORIGIN);
  const { session } = sec.pairSigned(ORIGIN, token);
  assert.equal(sec.authenticate(ORIGIN, `Bearer ${session}`), session);
  assert.throws(() => sec.authenticate('https://evil.example', `Bearer ${session}`), { code: 'PAIRING_REQUIRED' });
  assert.throws(() => sec.pairSigned(ORIGIN, token), { code: 'REPLAYED_REQUEST' });
});

test('signed pairing rejects bad signature, other origin, expiry and long-lived tokens', () => {
  const sec = new SecurityContext(cfg());
  assert.throws(() => sec.pairSigned(ORIGIN, signPairingToken('y'.repeat(40), ORIGIN)), { code: 'PAIRING_FAILED' });
  assert.throws(() => sec.pairSigned(ORIGIN, signPairingToken(SECRET, 'https://other.example')), { code: 'PAIRING_FAILED' });
  assert.throws(() => sec.pairSigned(ORIGIN, signPairingToken(SECRET, ORIGIN, { now: Date.now() - 120_000 })), { code: 'PAIRING_FAILED' });
  assert.throws(() => sec.pairSigned(ORIGIN, signPairingToken(SECRET, ORIGIN, { ttl: 3600 })), { code: 'PAIRING_FAILED' });
  assert.throws(() => sec.pairSigned('https://evil.example', signPairingToken(SECRET, 'https://evil.example')), { code: 'ORIGIN_NOT_ALLOWED' });
  assert.throws(() => sec.pairSigned(ORIGIN, 'garbage'), { code: 'PAIRING_FAILED' });
});

test('sessions expire', () => {
  let now = Date.now();
  const sec = new SecurityContext(cfg(), { now: () => now });
  const { session } = sec.pairSigned(ORIGIN, signPairingToken(SECRET, ORIGIN, { now }));
  now += 61_000;
  assert.throws(() => sec.authenticate(ORIGIN, `Bearer ${session}`), { code: 'SESSION_EXPIRED' });
});

test('code pairing requires the exact code and burns the request after 5 failures', () => {
  const sec = new SecurityContext(cfg({ pairingMode: 'code' }));
  const r = sec.requestPairingCode(ORIGIN);
  assert.match(r.code, /^\d{6}$/);
  assert.equal(sec.pendingCodes()[0].code, r.code);
  const wrong = r.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.throws(() => sec.confirmPairingCode(ORIGIN, r.requestId, wrong), (e) => e.code === 'PAIRING_FAILED' && e.details.reason === 'wrong_code' && e.details.attemptsLeft === 4 - i);
  const ok = sec.confirmPairingCode(ORIGIN, r.requestId, r.code);
  assert.ok(ok.session);

  const r2 = sec.requestPairingCode(ORIGIN);
  for (let i = 0; i < 5; i++) assert.throws(() => sec.confirmPairingCode(ORIGIN, r2.requestId, wrong));
  assert.throws(() => sec.confirmPairingCode(ORIGIN, r2.requestId, r2.code), (e) => e.details.reason === 'expired');
  assert.throws(() => sec.requestPairingCode('https://evil.example'), { code: 'ORIGIN_NOT_ALLOWED' });
});

test('request ids cannot be replayed and rate limiting kicks in', () => {
  const sec = new SecurityContext(cfg());
  sec.consumeRequestId('s1', 'abcdefgh1');
  assert.throws(() => sec.consumeRequestId('s1', 'abcdefgh1'), { code: 'REPLAYED_REQUEST' });
  assert.throws(() => sec.consumeRequestId('s1', 'x'), { code: 'INVALID_REQUEST' });
  for (let i = 0; i < 5; i++) sec.rateLimit('k');
  assert.throws(() => sec.rateLimit('k'), { code: 'RATE_LIMITED' });
});

test('host header check blocks DNS rebinding', () => {
  assert.ok(isAllowedHost('127.0.0.1:47115', 47115));
  assert.ok(isAllowedHost('localhost:47115', 47115));
  assert.ok(!isAllowedHost('evil.example:47115', 47115));
  assert.ok(!isAllowedHost(undefined, 47115));
});

test('origins must be explicit and https (except local dev hosts)', () => {
  assert.equal(normalizeOrigin('https://App.Example.com'), 'https://app.example.com');
  assert.equal(normalizeOrigin('http://localhost:8000'), 'http://localhost:8000');
  assert.equal(normalizeOrigin('http://scan.test'), 'http://scan.test');
  assert.throws(() => normalizeOrigin('*'));
  assert.throws(() => normalizeOrigin('https://*.example.com'));
  assert.throws(() => normalizeOrigin('http://app.example.com'));
  assert.throws(() => normalizeOrigin('https://app.example.com/path'));
});

test('config rejects short secrets and non-loopback hosts', () => {
  assert.throws(() => loadConfig({ overrides: { sites: [{ origin: ORIGIN, pairingSecret: 'short' }] }, env: { APPDATA: 'Z:\\nope', XDG_CONFIG_HOME: '/nonexistent' } }), /32 characters/);
  assert.throws(() => loadConfig({ overrides: { host: '0.0.0.0' }, env: { APPDATA: 'Z:\\nope', XDG_CONFIG_HOME: '/nonexistent' } }), /non-loopback/);
});

test('paper presets only include sizes that fit the declared area', () => {
  const legalBed = paperSizesFor({ widthMm: 216, heightMm: 355.6 }).map((p) => p.id);
  assert.deepEqual(legalBed, ['a4', 'a5', 'a6', 'letter', 'legal', 'max']);
  const a4Bed = paperSizesFor({ widthMm: 216, heightMm: 297 }).map((p) => p.id);
  assert.ok(!a4Bed.includes('legal') && !a4Bed.includes('a3'));
  const feeder = paperSizesFor({ widthMm: 216, heightMm: 356 }, { widthMm: 120, heightMm: 120 }).map((p) => p.id);
  assert.ok(!feeder.includes('a6'), 'below feeder minimum');
});

test('resolution support for lists and ranges', () => {
  assert.ok(resolutionSupported([150, 300], 300));
  assert.ok(!resolutionSupported([150, 300], 600));
  assert.ok(resolutionSupported({ min: 50, max: 300, step: 50 }, 250));
  assert.ok(!resolutionSupported({ min: 50, max: 300, step: 50 }, 275));
});

const CANON = JSON.parse(readFileSync(new URL('./fixtures/wia-canon-mf645c-caps.json', import.meta.url), 'utf8'));

test('WIA capabilities from a recorded Canon MF645C dump', () => {
  const caps = buildCapabilities({ id: 'wia:x', name: 'MF645C', adapter: 'wia' }, CANON);
  assert.deepEqual(caps.sources.map((s) => s.id), ['flatbed', 'feeder', 'duplex']);
  const flat = caps.sources[0];
  assert.deepEqual(flat.colorModes, ['color', 'gray']); // driver offers no lineart
  assert.deepEqual(flat.resolutions, [300]);
  assert.equal(flat.brightness, null, '0..0 range means not adjustable');
  assert.equal(flat.maxArea.widthMm, 216);
  assert.equal(flat.maxArea.heightMm, 355.6);
  assert.ok(flat.paperSizes.some((p) => p.id === 'legal'));
  assert.ok(!flat.paperSizes.some((p) => p.id === 'a3'));
  assert.equal(caps.status.feederReady, true);
  assert.equal(caps.status.attention, true);
  assert.equal(caps.device.simulated, false);
});

test('WIA capabilities without document handling select expose one default source', () => {
  const raw = { ...CANON, handlingSelect: null, perSelect: { 0: CANON.perSelect['2'] } };
  const caps = buildCapabilities({ id: 'wia:x' }, raw);
  assert.deepEqual(caps.sources.map((s) => s.id), ['flatbed']);
});

test('WIA HRESULTs map to unified codes', () => {
  assert.equal(mapWiaError({ hresult: '0x80210003' }).code, 'FEEDER_EMPTY');
  assert.equal(mapWiaError({ hresult: '0x80210002' }).code, 'PAPER_JAM');
  assert.equal(mapWiaError({ hresult: '0x80210016' }).code, 'COVER_OPEN');
  assert.equal(mapWiaError({ hresult: '0x80210006' }).code, 'DEVICE_BUSY');
  assert.equal(mapWiaError({ hresult: '0x12345678', stage: 'apply-settings' }).code, 'UNSUPPORTED_SETTING');
  assert.equal(mapWiaError({ hresult: '0x12345678', stage: 'transfer' }).code, 'DRIVER_ERROR');
  const http = mapWiaError({ hresult: '0x801901F4', stage: 'transfer' }); // observed on Canon MF645C (eSCL) ADF
  assert.equal(http.code, 'HARDWARE_ERROR');
  assert.equal(http.details.httpStatus, 500);
});

test('SANE device list and option parsing', () => {
  assert.deepEqual(parseDeviceList("device `epson2:libusb:001:004' is a Epson PerfectionV600 flatbed scanner\n"), [
    { id: 'epson2:libusb:001:004', description: 'Epson PerfectionV600 flatbed scanner' },
  ]);
  const opts = parseOptions(readFileSync(new URL('./fixtures/sane-options.txt', import.meta.url), 'utf8'));
  assert.deepEqual(opts.source.values, ['ADF Front', 'ADF Back', 'ADF Duplex']);
  assert.deepEqual(opts.mode.values, ['Lineart', 'Halftone', 'Gray', 'Color']);
  assert.deepEqual(opts.resolution.range, { min: 50, max: 600, step: 1 });
  assert.equal(opts.x.range.max, 215.872);
  assert.equal(opts.gamma.inactive, true);

  const src = buildSource('ADF Duplex', opts, 2);
  assert.equal(src.kind, 'duplex');
  assert.deepEqual(src.colorModes, ['color', 'gray', 'bw']);
  assert.equal(src.saneModes.bw, 'Lineart');
  assert.deepEqual(src.brightness, { min: -127, max: 127, step: 1 });
  assert.deepEqual(src.contrast, { min: -127, max: 127, step: 1 });
  assert.equal(classifySource('Flatbed'), 'flatbed');
  assert.equal(classifySource('Transparency Unit'), 'other');
});

test('SANE stderr mapping', () => {
  assert.equal(mapSaneError('scanimage: sane_start: Document feeder out of documents', 0).code, 'FEEDER_EMPTY');
  assert.equal(mapSaneError('scanimage: sane_start: Document feeder out of documents', 3), null);
  assert.equal(mapSaneError('scanimage: sane_read: Document feeder jammed').code, 'PAPER_JAM');
  assert.equal(mapSaneError('scanimage: open of device x failed: Access to resource has been denied').code, 'PERMISSION_DENIED');
});

test('PNG encoder output is a valid PNG with the right size', () => {
  const r = new Raster(40, 30, 1);
  r.fillRect(0, 0, 10, 10, [0, 0, 0]);
  assert.deepEqual(imageInfo(r.toPng()), { mime: 'image/png', width: 40, height: 30 });
});

test('validateSettings rejects anything the device did not declare', () => {
  const caps = buildCapabilities({ id: 'wia:x' }, CANON);
  const ok = validateSettings(caps, { source: 'flatbed', colorMode: 'gray', resolution: 300, paper: { id: 'a4' } }, { maxPages: 50 });
  assert.equal(ok.maxPages, 1, 'flatbed scans one page');
  assert.throws(() => validateSettings(caps, { source: 'flatbed', colorMode: 'bw', resolution: 300 }, { maxPages: 50 }), { code: 'UNSUPPORTED_SETTING' });
  assert.throws(() => validateSettings(caps, { source: 'flatbed', resolution: 600 }, { maxPages: 50 }), { code: 'UNSUPPORTED_SETTING' });
  assert.throws(() => validateSettings(caps, { source: 'film' }, { maxPages: 50 }), { code: 'SOURCE_UNAVAILABLE' });
  assert.throws(() => validateSettings(caps, { source: 'flatbed', paper: { id: 'a3' } }, { maxPages: 50 }), { code: 'UNSUPPORTED_SETTING' });
  assert.throws(() => validateSettings(caps, { source: 'flatbed', brightness: 10 }, { maxPages: 50 }), { code: 'UNSUPPORTED_SETTING' });
  assert.throws(() => validateSettings(caps, { source: 'feeder', maxPages: 51 }, { maxPages: 50 }), { code: 'UNSUPPORTED_SETTING' });
  const custom = validateSettings(caps, { source: 'flatbed', paper: { id: 'custom', widthMm: 100, heightMm: 100 } }, { maxPages: 50 });
  assert.equal(custom.area.widthMm, 100);
  assert.throws(() => validateSettings(caps, { source: 'flatbed', paper: { id: 'custom', widthMm: 500, heightMm: 100 } }, { maxPages: 50 }), { code: 'UNSUPPORTED_SETTING' });
});

test('log redaction removes secrets and binary data', () => {
  const out = redact({ token: 'abc', code: 'PAPER_JAM', pairingCode: '123456', nested: { authorization: 'Bearer x', ok: 1 }, data: Buffer.alloc(10) });
  assert.equal(out.code, 'PAPER_JAM', 'error codes stay visible');
  assert.equal(out.pairingCode, '[redacted]');
  assert.equal(out.token, '[redacted]');
  assert.equal(out.nested.authorization, '[redacted]');
  assert.equal(out.nested.ok, 1);
  assert.equal(out.data, '<10 bytes>');
});

test('AgentError serialises with action hints and correlation id', () => {
  const e = new AgentError('FEEDER_EMPTY', 'empty');
  assert.deepEqual(e.toJSON('cid12345'), { code: 'FEEDER_EMPTY', message: 'empty', action: 'load_paper', correlationId: 'cid12345' });
  assert.equal(new AgentError('NOPE').code, 'INTERNAL_ERROR');
});

/* ---------- Windows.Devices.Scanners (winrt) ---------- */
import { buildWinRtCapabilities, scanPayload } from '../src/adapters/winrt.js';
import { createAdapters } from '../src/adapters/index.js';

const WINRT_CANON = JSON.parse(readFileSync(new URL('./fixtures/winrt-canon-mf645c-caps.json', import.meta.url), 'utf8'));

test('WinRT capabilities from a recorded Canon MF645C (feeder sizes come from the driver)', () => {
  const caps = buildWinRtCapabilities({ id: 'win:x', name: 'Canon', adapter: 'winrt' }, WINRT_CANON);
  assert.deepEqual(caps.sources.map((s) => s.id), ['flatbed', 'feeder', 'duplex']);
  const [flat, feeder, duplex] = caps.sources;
  assert.deepEqual(flat.resolutions, [300]);
  assert.deepEqual(flat.colorModes, ['color', 'gray']);
  assert.equal(flat.brightness, null);
  assert.equal(flat.maxArea.widthMm, 216);
  assert.equal(flat.maxArea.heightMm, 355.6);
  assert.equal(flat.customArea, true);
  assert.deepEqual(feeder.paperSizes.map((p) => p.id), ['a4', 'a5', 'a6', 'letter', 'legal'], 'exactly the driver-declared feeder sizes');
  assert.equal(feeder.customArea, false, 'this API has no feeder scan region');
  assert.equal(duplex.duplex, true);
  assert.equal(feeder.winrtFormat, 'Jpeg', 'PNG not offered by this driver');
  assert.equal(caps.status.reportedByDriver, false);
});

test('WinRT scan payload: flatbed region in inches, feeder page size and page cap', () => {
  const caps = buildWinRtCapabilities({ id: 'win:x' }, WINRT_CANON);
  const flat = validateSettings(caps, { source: 'flatbed', colorMode: 'gray', resolution: 300, paper: { id: 'a4' } }, { maxPages: 50 });
  assert.deepEqual(scanPayload(caps.sources[0], flat), { source: 'Flatbed', format: 'Jpeg', colorMode: 'Grayscale', dpi: 300, brightness: null, contrast: null, widthIn: 8.268, heightIn: 11.693 });
  const dup = validateSettings(caps, { source: 'duplex', colorMode: 'color', resolution: 300, paper: { id: 'letter' }, maxPages: 10 }, { maxPages: 50 });
  const p = scanPayload(caps.sources[2], dup);
  assert.equal(p.pageSize, 'NorthAmericaLetter');
  assert.equal(p.duplex, true);
  assert.equal(p.maxPages, 10);
  assert.throws(() => validateSettings(caps, { source: 'feeder', paper: { id: 'custom', widthMm: 100, heightMm: 100 } }, { maxPages: 50 }), { code: 'UNSUPPORTED_SETTING' });
});

test('auto adapter selection: winrt on Windows, sane on Linux, never the simulator', () => {
  const cfg = { adapters: ['auto'], scanTimeoutSeconds: 60, simulator: {} };
  assert.deepEqual(createAdapters(cfg, 'win32').map((a) => a.name), ['winrt']);
  assert.deepEqual(createAdapters(cfg, 'linux').map((a) => a.name), ['sane']);
  assert.deepEqual(createAdapters({ ...cfg, adapters: ['wia', 'simulator'] }, 'win32').map((a) => a.name), ['wia', 'simulator']);
});
