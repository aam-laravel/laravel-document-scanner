import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { AgentError } from './errors.js';

const MAX_TOKEN_LIFETIME = 300; // seconds; Laravel mints tokens valid for ~60s

export function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromB64url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Create a pairing token exactly like the Laravel package does (used by tests and the CLI). */
export function signPairingToken(secret, origin, { ttl = 60, now = Date.now(), nonce = b64url(randomBytes(16)) } = {}) {
  const payload = b64url(JSON.stringify({ o: origin, n: nonce, e: Math.floor(now / 1000) + ttl }));
  const sig = b64url(createHmac('sha256', secret).update(`v1.${payload}`).digest());
  return `v1.${payload}.${sig}`;
}

/**
 * DNS-rebinding protection: the Host header must name the loopback listener.
 */
export function isAllowedHost(hostHeader, port) {
  if (!hostHeader) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(hostHeader.toLowerCase());
}

export class SecurityContext {
  constructor(config, { now = () => Date.now() } = {}) {
    this.config = config;
    this.now = now;
    this.sites = new Map(config.sites.map((s) => [s.origin, s]));
    this.sessions = new Map(); // token -> { origin, expires, created }
    this.usedNonces = new Map(); // nonce -> expiry ms
    this.usedRequestIds = new Map(); // `${session}:${requestId}` -> expiry ms
    this.pairRequests = new Map(); // requestId -> { origin, code, expires, attempts }
    this.buckets = new Map(); // key -> { tokens, updated }
  }

  isAllowedOrigin(origin) {
    return typeof origin === 'string' && this.sites.has(origin);
  }

  /** Verify a Laravel-minted HMAC token and open a session bound to the origin. */
  pairSigned(origin, token) {
    if (this.config.pairingMode !== 'signed') throw new AgentError('PAIRING_FAILED', 'Signed pairing is disabled on this agent.');
    const site = this.sites.get(origin);
    if (!site) throw new AgentError('ORIGIN_NOT_ALLOWED', 'Origin is not allowed.');
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3 || parts[0] !== 'v1') throw new AgentError('PAIRING_FAILED', 'Malformed pairing token.');
    const expected = createHmac('sha256', site.pairingSecret).update(`v1.${parts[1]}`).digest();
    const given = fromB64url(parts[2]);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new AgentError('PAIRING_FAILED', 'Pairing token signature is invalid.');
    }
    let payload;
    try {
      payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    } catch {
      throw new AgentError('PAIRING_FAILED', 'Malformed pairing token.');
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (payload.o !== origin) throw new AgentError('PAIRING_FAILED', 'Pairing token was issued for another origin.');
    if (typeof payload.e !== 'number' || payload.e < nowSec || payload.e - nowSec > MAX_TOKEN_LIFETIME) {
      throw new AgentError('PAIRING_FAILED', 'Pairing token has expired.');
    }
    if (typeof payload.n !== 'string' || payload.n.length < 16) throw new AgentError('PAIRING_FAILED', 'Malformed pairing token.');
    this.gc();
    if (this.usedNonces.has(payload.n)) throw new AgentError('REPLAYED_REQUEST', 'Pairing token was already used.');
    this.usedNonces.set(payload.n, payload.e * 1000);
    return this.openSession(origin);
  }

  /** Code pairing, step 1: the browser asks for a code that only the local user can see. */
  requestPairingCode(origin) {
    if (this.config.pairingMode !== 'code') throw new AgentError('PAIRING_FAILED', 'Code pairing is disabled on this agent.');
    if (!this.isAllowedOrigin(origin)) throw new AgentError('ORIGIN_NOT_ALLOWED', 'Origin is not allowed.');
    this.gc();
    const requestId = b64url(randomBytes(12));
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pairRequests.set(requestId, { origin, code, expires: this.now() + 120_000, attempts: 0 });
    return { requestId, code, expiresAt: new Date(this.now() + 120_000).toISOString() };
  }

  /** Code pairing, step 2. Five wrong attempts burn the request. */
  confirmPairingCode(origin, requestId, code) {
    const req = this.pairRequests.get(requestId);
    if (!req || req.origin !== origin || req.expires < this.now()) {
      throw new AgentError('PAIRING_FAILED', 'Pairing request expired; start again.', { reason: 'expired' });
    }
    req.attempts++;
    const ok = typeof code === 'string' && code.length === req.code.length && timingSafeEqual(Buffer.from(code), Buffer.from(req.code));
    if (!ok) {
      const burned = req.attempts >= 5;
      if (burned) this.pairRequests.delete(requestId);
      throw new AgentError('PAIRING_FAILED', 'Pairing code is incorrect.', { reason: burned ? 'expired' : 'wrong_code', attemptsLeft: burned ? 0 : 5 - req.attempts });
    }
    this.pairRequests.delete(requestId);
    return this.openSession(origin);
  }

  /** Codes waiting for confirmation, shown on the agent's local status page only. */
  pendingCodes() {
    this.gc();
    return [...this.pairRequests.values()].map((r) => ({ origin: r.origin, code: r.code, expiresAt: new Date(r.expires).toISOString() }));
  }

  openSession(origin) {
    const token = b64url(randomBytes(32));
    const expires = this.now() + this.config.sessionTtlSeconds * 1000;
    this.sessions.set(token, { origin, expires, created: this.now() });
    return { session: token, expiresAt: new Date(expires).toISOString() };
  }

  /** Validate bearer session, bound to the same origin; sliding expiry capped at 8h. */
  authenticate(origin, authHeader) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(authHeader || '');
    if (!m) throw new AgentError('PAIRING_REQUIRED', 'Pair with the agent first.');
    const s = this.sessions.get(m[1]);
    if (!s || s.origin !== origin) throw new AgentError('PAIRING_REQUIRED', 'Pair with the agent first.');
    if (s.expires < this.now()) {
      this.sessions.delete(m[1]);
      throw new AgentError('SESSION_EXPIRED', 'Agent session expired; pair again.');
    }
    s.expires = Math.min(this.now() + this.config.sessionTtlSeconds * 1000, s.created + 8 * 3600_000);
    return m[1];
  }

  revoke(token) {
    this.sessions.delete(token);
  }

  /** Reject replays of state-changing commands (each carries a unique requestId). */
  consumeRequestId(session, requestId) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
      throw new AgentError('INVALID_REQUEST', 'requestId is required (8-64 url-safe chars).');
    }
    const key = `${session}:${requestId}`;
    if (this.usedRequestIds.has(key)) throw new AgentError('REPLAYED_REQUEST', 'This request was already processed.');
    this.usedRequestIds.set(key, this.now() + 3600_000);
  }

  /** Token bucket per key (origin or remote address). */
  rateLimit(key, perMinute = this.config.maxRequestsPerMinute) {
    const now = this.now();
    const b = this.buckets.get(key) || { tokens: perMinute, updated: now };
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.updated) / 60_000) * perMinute);
    b.updated = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      throw new AgentError('RATE_LIMITED', 'Too many requests; slow down.');
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
  }

  gc() {
    const now = this.now();
    for (const [k, exp] of this.usedNonces) if (exp < now) this.usedNonces.delete(k);
    for (const [k, exp] of this.usedRequestIds) if (exp < now) this.usedRequestIds.delete(k);
    for (const [k, r] of this.pairRequests) if (r.expires < now) this.pairRequests.delete(k);
    for (const [k, s] of this.sessions) if (s.expires < now) this.sessions.delete(k);
  }
}
