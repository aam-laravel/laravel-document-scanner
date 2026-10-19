#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, defaultPaths, normalizeOrigin, DEFAULT_PORT } from '../src/config.js';
import { createAgent } from '../src/server.js';
import { createAdapters, AdapterRegistry } from '../src/adapters/index.js';
import { validateSettings } from '../src/capabilities.js';
import { Logger } from '../src/logger.js';
import { VERSION, PROTOCOL, BUILD_DATE } from '../src/version.js';

const HELP = `document-scanner-agent ${VERSION} (protocol ${PROTOCOL})

Usage: scanner-agent <command> [options]

Commands:
  run                    Start the agent (foreground; use the install scripts for autostart)
  status                 Query a running agent's /v1/health
  devices                List scanners detected by the enabled adapters
  caps <deviceId>        Print the capabilities reported by a scanner
  test-scan <deviceId>   Scan once to a local folder (diagnostic mode)
  diagnose               Print a redacted diagnostic report (JSON)
  init-config            Create the config file (--origin required)
  gen-secret             Print a random pairing secret
  version                Print version information

Options:
  --config <file>        Config file (default: ${defaultPaths().config})
  --adapter <name>       auto | wia | sane | simulator (repeatable)
  --port <n>             Listen port (default ${DEFAULT_PORT})
  --origin <url>         (init-config) allowed web application origin
  --secret <value>       (init-config) pairing secret shared with Laravel
  --pairing-mode <mode>  (init-config) signed | code
  --source/--dpi/--color/--paper/--out   (test-scan) scan settings
  --force                (init-config) overwrite an existing file
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    adapter: { type: 'string', multiple: true },
    port: { type: 'string' },
    origin: { type: 'string', multiple: true },
    secret: { type: 'string' },
    'pairing-mode': { type: 'string' },
    source: { type: 'string' },
    dpi: { type: 'string' },
    color: { type: 'string' },
    paper: { type: 'string' },
    out: { type: 'string' },
    force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command = 'help', arg] = positionals;

function config() {
  return loadConfig({
    path: opts.config,
    overrides: {
      adapters: opts.adapter?.flatMap((a) => a.split(',')),
      port: opts.port ? Number(opts.port) : undefined,
    },
  });
}

function registry(cfg) {
  return new AdapterRegistry(createAdapters(cfg), new Logger({ level: 'warning', file: null }));
}

const print = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');

async function main() {
  if (opts.help || command === 'help') return void process.stdout.write(HELP);

  switch (command) {
    case 'version':
      return print({ version: VERSION, protocol: PROTOCOL, buildDate: BUILD_DATE, node: process.version, platform: process.platform });

    case 'gen-secret':
      return void process.stdout.write(randomBytes(32).toString('base64url') + '\n');

    case 'init-config': {
      const file = resolve(opts.config || defaultPaths().config);
      if (existsSync(file) && !opts.force) throw new Error(`${file} exists; pass --force to overwrite.`);
      if (!opts.origin?.length) throw new Error('--origin https://your-app.example is required.');
      const mode = opts['pairing-mode'] || 'signed';
      const secret = opts.secret || (mode === 'signed' ? randomBytes(32).toString('base64url') : null);
      const cfg = {
        port: opts.port ? Number(opts.port) : DEFAULT_PORT,
        adapters: opts.adapter?.flatMap((a) => a.split(',')) || ['auto'],
        pairingMode: mode,
        sites: opts.origin.map((o) => ({ origin: normalizeOrigin(o), ...(secret ? { pairingSecret: secret } : {}) })),
        logLevel: 'info',
      };
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
      process.stdout.write(`Wrote ${file}\n`);
      if (secret && !opts.secret) process.stdout.write(`Set DOCUMENT_SCANNER_AGENT_SECRET in the Laravel .env to the pairingSecret stored in that file.\n`);
      return;
    }

    case 'run': {
      const cfg = config();
      if (!cfg.sites.length) process.stderr.write('Warning: no allowed sites configured; browsers cannot use this agent. Run "scanner-agent init-config".\n');
      const agent = createAgent(cfg);
      await agent.start();
      const stop = async () => {
        agent.logger.info('agent stopping');
        await agent.stop();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }

    case 'status': {
      const cfg = config();
      try {
        const r = await fetch(`http://127.0.0.1:${cfg.port}/v1/health`, { signal: AbortSignal.timeout(3000) });
        print({ running: true, ...(await r.json()) });
      } catch {
        print({ running: false, port: cfg.port });
        process.exitCode = 3;
      }
      return;
    }

    case 'devices': {
      const r = await registry(config()).listDevices();
      return print(r);
    }

    case 'caps': {
      if (!arg) throw new Error('caps <deviceId>');
      const reg = registry(config());
      return print(await reg.forDevice(arg).getCapabilities(arg));
    }

    case 'test-scan': {
      if (!arg) throw new Error('test-scan <deviceId>');
      const cfg = config();
      const adapter = registry(cfg).forDevice(arg);
      const caps = await adapter.getCapabilities(arg);
      const settings = validateSettings(
        caps,
        {
          source: opts.source || caps.sources[0].id,
          resolution: opts.dpi ? Number(opts.dpi) : undefined,
          colorMode: opts.color,
          paper: opts.paper ? { id: opts.paper } : undefined,
        },
        { maxPages: cfg.maxPagesPerJob },
      );
      const outDir = resolve(opts.out || mkdtempSync(join(tmpdir(), 'scanner-test-')));
      mkdirSync(outDir, { recursive: true });
      const pages = [];
      const started = Date.now();
      await adapter.scan(arg, settings, {
        outDir,
        signal: AbortSignal.timeout(cfg.scanTimeoutSeconds * 1000),
        onPage: (p) => pages.push(p),
      });
      return print({ settings, outDir, seconds: (Date.now() - started) / 1000, pages: pages.map(({ file, ...p }) => ({ file, ...p })) });
    }

    case 'diagnose': {
      const cfg = config();
      const reg = registry(cfg);
      const { devices, problems } = await reg.listDevices();
      const caps = [];
      for (const d of devices) {
        try {
          const c = await reg.forDevice(d.id).getCapabilities(d.id);
          caps.push({ id: d.id, sources: c.sources.map((s) => ({ id: s.id, colorModes: s.colorModes, resolutions: s.resolutions, maxArea: s.maxArea, paperSizes: s.paperSizes.map((p) => p.id) })), status: c.status });
        } catch (e) {
          caps.push({ id: d.id, error: e.code || 'INTERNAL_ERROR' });
        }
      }
      return print({
        version: VERSION,
        protocol: PROTOCOL,
        buildDate: BUILD_DATE,
        node: process.version,
        platform: process.platform,
        configFile: cfg.configFile,
        port: cfg.port,
        pairingMode: cfg.pairingMode,
        sites: cfg.sites.map((s) => s.origin), // secrets intentionally omitted
        adapters: await reg.status(),
        devices,
        problems,
        capabilities: caps,
      });
    }

    default:
      process.stderr.write(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(`Error: ${e.code ? `${e.code}: ` : ''}${e.message}\n`);
  process.exitCode = 1;
});
