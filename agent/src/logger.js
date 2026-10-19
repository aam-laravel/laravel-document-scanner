import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warning: 30, error: 40 };
const SECRET_KEYS = /^(authorization|token|session|secret|pairingsecret|pairingcode|password|cookie)$/i;

/** Recursively replace values under secret-looking keys. Never logs image data. */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return value.slice(0, 500) + '…';
  return value;
}

export class Logger {
  /**
   * @param {{level?: string, file?: string|null, maxBytes?: number, maxFiles?: number, console?: boolean}} opts
   */
  constructor(opts = {}) {
    this.level = LEVELS[opts.level] ? opts.level : 'info';
    this.file = opts.file || null;
    this.maxBytes = opts.maxBytes ?? 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 3;
    this.console = opts.console ?? true;
    this.recent = []; // ring buffer of warnings/errors for the diagnostics report
    if (this.file) mkdirSync(dirname(this.file), { recursive: true });
  }

  log(level, message, context = {}) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const entry = { time: new Date().toISOString(), level, message, ...redact(context) };
    const line = JSON.stringify(entry);
    if (LEVELS[level] >= LEVELS.warning) {
      this.recent.push(entry);
      if (this.recent.length > 50) this.recent.shift();
    }
    if (this.console) (LEVELS[level] >= LEVELS.warning ? process.stderr : process.stdout).write(line + '\n');
    if (this.file) {
      try {
        this.rotate();
        appendFileSync(this.file, line + '\n', { mode: 0o600 });
      } catch {
        // logging must never break scanning
      }
    }
  }

  rotate() {
    if (!existsSync(this.file) || statSync(this.file).size < this.maxBytes) return;
    rmSync(`${this.file}.${this.maxFiles}`, { force: true });
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    }
    renameSync(this.file, `${this.file}.1`);
  }

  debug(m, c) { this.log('debug', m, c); }
  info(m, c) { this.log('info', m, c); }
  warning(m, c) { this.log('warning', m, c); }
  error(m, c) { this.log('error', m, c); }
}
