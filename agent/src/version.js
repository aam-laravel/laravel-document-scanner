import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Agent semantic version (from package.json). */
export const VERSION = pkg.version;

/**
 * Wire protocol version. The browser client refuses to talk to an agent whose
 * protocol differs from the one it was written for (see docs/agent-protocol.md).
 */
export const PROTOCOL = 1;

/** Build date: injected by the packaging script via env, else "development". */
export const BUILD_DATE = process.env.SCANNER_AGENT_BUILD_DATE || 'development';

export const AGENT_NAME = 'document-scanner-agent';
export const AGENT_ROOT = root;
