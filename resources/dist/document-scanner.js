/**
 * Entry point. Auto-mounts every element rendered by <x-document-scanner>
 * and exposes a small JavaScript API on window.DocumentScanner:
 *
 *   DocumentScanner.mount(element, { config, options })
 *   await DocumentScanner.mountFromUrl(element, '/document-scanner/config', { output: 'upload' })
 *
 * Events (bubbling CustomEvents on the root element):
 *   document-scanner:uploaded  detail.document = {id, filename, pages, size, downloadUrl, ...}
 *   document-scanner:attached  detail = {pages, size}           (output: 'form-file')
 *   document-scanner:error     detail.code
 */
import { ScannerApp } from './scanner-app.js';

const instances = new WeakMap();

export function mount(element, { config, options = {} }) {
  if (instances.has(element)) return instances.get(element);
  if (!config || !config.agent || !config.endpoints) throw new Error('DocumentScanner: config with agent and endpoints is required');
  element.classList.add('ds-root');
  element.setAttribute('dir', element.getAttribute('dir') || config.dir || 'ltr');
  if (!element.querySelector('[data-ds-output]') && options.name) {
    const input = document.createElement('input');
    input.type = options.output === 'form-file' ? 'file' : 'hidden';
    input.name = options.name;
    input.dataset.dsOutput = '';
    if (input.type === 'file') input.className = 'ds-visually-hidden';
    element.append(input);
  }
  const app = new ScannerApp(element, { config, options });
  instances.set(element, app);
  return app;
}

/** Fetch the client config from the package endpoint (same-origin, authenticated) and mount. */
export async function mountFromUrl(element, configUrl, options = {}) {
  const r = await fetch(configUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`DocumentScanner: config request failed (${r.status})`);
  return mount(element, { config: await r.json(), options });
}

function autoMount() {
  for (const el of document.querySelectorAll('[data-document-scanner]')) {
    if (instances.has(el)) continue;
    const json = el.querySelector('script[data-ds-config]');
    if (!json) continue;
    try {
      const { config, options } = JSON.parse(json.textContent);
      mount(el, { config, options });
    } catch (e) {
      console.error('DocumentScanner: failed to mount', e);
    }
  }
}

window.DocumentScanner = { mount, mountFromUrl, autoMount, instance: (el) => instances.get(el) };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
else autoMount();
