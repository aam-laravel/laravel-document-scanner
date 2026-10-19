import { readFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_PORT = 47115;

/** Per-OS default locations (user scope; the agent never needs admin rights). */
export function defaultPaths(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const appData = env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return {
      config: join(appData, 'DocumentScannerAgent', 'config.json'),
      log: join(localAppData, 'DocumentScannerAgent', 'logs', 'agent.log'),
    };
  }
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const stateHome = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return {
    config: join(configHome, 'document-scanner-agent', 'config.json'),
    log: join(stateHome, 'document-scanner-agent', 'agent.log'),
  };
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: DEFAULT_PORT,
  adapters: ['auto'],
  pairingMode: 'signed', // "signed" (HMAC token minted by Laravel) or "code" (user types a code shown by the agent)
  sites: [], // [{ origin: "https://app.example.com", pairingSecret: "..." }]
  sessionTtlSeconds: 1800,
  jobTtlSeconds: 900,
  scanTimeoutSeconds: 600,
  maxPagesPerJob: 200,
  maxRequestsPerMinute: 240,
  tempDir: null,
  logLevel: 'info',
  logFile: undefined, // undefined → OS default, null → no file logging
  simulator: {
    pageDelayMs: 600,
    feederSheets: 3,
  },
};

/**
 * Origins must be explicit scheme://host[:port]. Wildcards are rejected, and
 * plain http is only allowed for loopback development hosts.
 */
export function normalizeOrigin(origin) {
  if (typeof origin !== 'string' || origin.includes('*')) {
    throw new Error(`Invalid origin "${origin}": wildcards are not allowed.`);
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`Invalid origin "${origin}".`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username) {
    throw new Error(`Origin "${origin}" must not contain a path, query or credentials.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.test');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`Origin "${origin}" must use https (http is only accepted for localhost/.test development hosts).`);
  }
  return url.origin;
}

export function loadConfig({ path, overrides = {}, env = process.env } = {}) {
  const paths = defaultPaths(process.platform, env);
  const file = path ? resolve(path) : env.SCANNER_AGENT_CONFIG || paths.config;
  let fromFile = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Cannot parse agent config ${file}: ${e.message}`);
    }
  } else if (path) {
    throw new Error(`Agent config file not found: ${file}`);
  }

  const cfg = {
    ...DEFAULTS,
    ...fromFile,
    ...stripUndefined(overrides),
    simulator: { ...DEFAULTS.simulator, ...(fromFile.simulator || {}), ...(overrides.simulator || {}) },
  };
  if (env.SCANNER_AGENT_PORT) cfg.port = Number(env.SCANNER_AGENT_PORT);

  if (!Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535) {
    throw new Error(`Invalid port ${cfg.port}; use 1024-65535.`);
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(cfg.host)) {
    throw new Error(`Refusing to listen on non-loopback host "${cfg.host}".`);
  }
  if (!['signed', 'code'].includes(cfg.pairingMode)) {
    throw new Error(`pairingMode must be "signed" or "code".`);
  }
  if (!Array.isArray(cfg.adapters)) cfg.adapters = [cfg.adapters];

  cfg.sites = (cfg.sites || []).map((s) => {
    const site = { origin: normalizeOrigin(s.origin), pairingSecret: s.pairingSecret || null };
    if (cfg.pairingMode === 'signed' && (!site.pairingSecret || site.pairingSecret.length < 32)) {
      throw new Error(`Site ${site.origin} needs a pairingSecret of at least 32 characters in "signed" pairing mode.`);
    }
    return site;
  });

  cfg.tempDir = cfg.tempDir ? resolve(cfg.tempDir) : join(tmpdir(), 'document-scanner-agent');
  if (cfg.logFile === undefined) cfg.logFile = paths.log;
  cfg.configFile = existsSync(file) ? file : null;
  return cfg;
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
