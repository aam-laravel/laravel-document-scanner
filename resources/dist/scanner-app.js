import { AgentClient } from './agent-client.js';
import { ScannerError, toScannerError, uuid } from './errors.js';
import { PageStore } from './page-store.js';
import { buildPdf, verifyPdf } from './pdf-writer.js';
import { processScannedImage, renderForPdf } from './image-tools.js';
import { Uploader } from './uploader.js';

const COMMON_DPI = [75, 100, 150, 200, 240, 300, 400, 600, 1200];

/** Tiny DOM helper: h('button', {class:'x', onclick}, 'text', child) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) { if (dv !== undefined && dv !== null) el.dataset[dk] = dv; }
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function formatBytes(n, locale) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i ? 1 : 0 }).format(v)} ${units[i]}`;
}

/** Resolution choices: device list, or common values inside a device range; capped by maxDpi. */
export function resolutionChoices(res, maxDpi) {
  let list;
  if (Array.isArray(res)) list = res;
  else if (res && typeof res === 'object') list = COMMON_DPI.filter((d) => d >= res.min && d <= res.max && (!res.step || (d - res.min) % res.step === 0));
  else list = [];
  return list.filter((d) => !maxDpi || d <= maxDpi);
}

export class ScannerApp {
  constructor(root, { config, options = {} }) {
    this.root = root;
    this.config = config;
    this.options = options;
    this.messages = config.messages || {};
    this.locale = config.locale || document.documentElement.lang || 'en';
    this.output = root.querySelector('[data-ds-output]');
    this.form = root.closest('form');
    this.pages = new PageStore();
    this.agent = new AgentClient({
      url: config.agent.url,
      protocol: config.agent.protocol,
      minVersion: config.agent.minVersion,
      probeTimeoutMs: config.timeouts?.agent_probe_ms,
      requestTimeoutMs: config.timeouts?.agent_request_ms,
    });
    this.uploader = new Uploader({ endpoints: config.endpoints, csrfToken: config.csrfToken, uploadTimeoutMs: (config.timeouts?.upload_seconds || 300) * 1000 });
    this.state = {
      agent: 'checking',
      devices: [],
      deviceId: null,
      caps: null,
      sourceId: null,
      busy: false,
      scanAbort: null,
      pdf: null, // {blob, url, pages, version}
      uploaded: null,
      errors: [],
    };
    this.selectedPageId = null;
    this.zoom = 1;
    this.build();
    this.pages.subscribe(() => this.renderPages());
    this.bindForm();
    window.addEventListener('beforeunload', (e) => {
      if (this.pages.length && !this.state.uploaded) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    window.addEventListener('pagehide', () => this.pages.clear());
    this.connect();
  }

  /* ---------------- i18n ---------------- */

  t(key, params = {}) {
    let s = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), this.messages);
    if (typeof s !== 'string') s = key;
    for (const [k, v] of Object.entries(params)) s = s.split(`:${k}`).join(String(v));
    return s;
  }

  errorText(err) {
    return this.messages.errors?.[err.code] || this.messages.errors?.UNKNOWN || err.message;
  }

  /* ---------------- layout ---------------- */

  build() {
    const id = this.root.id || `ds-${uuid().slice(0, 8)}`;
    this.ids = { status: `${id}-status`, scanMsg: `${id}-scan-msg`, outMsg: `${id}-out-msg` };

    this.el = {};
    this.el.banner = h('div', { class: 'ds-banner', role: 'note', hidden: true }, this.t('ui.simulator_banner'));

    // agent + device status
    this.el.agentState = h('span', { class: 'ds-badge', dataset: { state: 'checking' } }, this.t('agent_state.checking'));
    this.el.agentRetry = h('button', { type: 'button', class: 'ds-btn ds-btn-secondary', hidden: true, onclick: () => this.connect() }, this.t('ui.retry'));
    this.el.agentHelp = h('div', { class: 'ds-help', hidden: true });
    this.el.pairBox = h('div', { class: 'ds-pair', hidden: true });
    this.el.agentError = h('div', { class: 'ds-error-slot' });
    this.el.deviceState = h('span', { class: 'ds-badge', dataset: { state: 'unknown' } }, '');

    const statusSection = h(
      'section',
      { class: 'ds-card ds-status', 'aria-labelledby': this.ids.status },
      h('div', { class: 'ds-row' }, h('strong', { id: this.ids.status }, this.t('ui.agent')), this.el.agentState, this.el.agentRetry),
      this.el.pairBox,
      this.el.agentHelp,
      this.el.agentError,
    );

    // settings
    this.el.device = h('select', { id: `${id}-device`, onchange: () => this.selectDevice(this.el.device.value) });
    this.el.source = h('select', { id: `${id}-source`, onchange: () => this.selectSource(this.el.source.value) });
    this.el.color = h('select', { id: `${id}-color` });
    this.el.dpi = h('select', { id: `${id}-dpi`, onchange: () => this.updateDpiWarning() });
    this.el.dpiWarn = h('p', { class: 'ds-hint ds-warn', hidden: true }, this.t('ui.high_dpi_warning'));
    this.el.paper = h('select', { id: `${id}-paper`, onchange: () => this.updatePaper() });
    this.el.paperHint = h('p', { class: 'ds-hint' });
    this.el.customW = h('input', { id: `${id}-w`, type: 'number', step: '0.1', inputmode: 'decimal' });
    this.el.customH = h('input', { id: `${id}-h`, type: 'number', step: '0.1', inputmode: 'decimal' });
    this.el.custom = h(
      'div',
      { class: 'ds-row ds-custom', hidden: true },
      h('label', { for: `${id}-w` }, this.t('ui.width_mm'), this.el.customW),
      h('label', { for: `${id}-h` }, this.t('ui.height_mm'), this.el.customH),
    );
    this.el.brightness = h('input', { id: `${id}-brightness`, type: 'range' });
    this.el.brightnessNote = h('span', { class: 'ds-hint' });
    this.el.contrast = h('input', { id: `${id}-contrast`, type: 'range' });
    this.el.contrastNote = h('span', { class: 'ds-hint' });

    const field = (label, control, ...extra) => h('div', { class: 'ds-field' }, h('label', { for: control.id }, label), control, ...extra);
    this.el.scanBtn = h('button', { type: 'button', class: 'ds-btn ds-btn-primary', disabled: true, onclick: () => this.scan() }, this.t('ui.scan'));
    this.el.cancelBtn = h('button', { type: 'button', class: 'ds-btn ds-btn-secondary', hidden: true, onclick: () => this.cancelScan() }, this.t('ui.cancel_scan'));
    this.el.progress = h('progress', { class: 'ds-progress', hidden: true });
    this.el.scanMsg = h('p', { id: this.ids.scanMsg, class: 'ds-live', role: 'status', 'aria-live': 'polite' });
    this.el.scanError = h('div', { class: 'ds-error-slot' });

    this.el.settings = h(
      'fieldset',
      { class: 'ds-card ds-settings', disabled: true },
      h('legend', {}, this.t('ui.scanner')),
      h('div', { class: 'ds-grid' },
        field(this.t('ui.scanner'), this.el.device, this.el.deviceState),
        field(this.t('ui.source'), this.el.source),
        field(this.t('ui.color_mode'), this.el.color),
        field(this.t('ui.resolution'), this.el.dpi, this.el.dpiWarn),
        field(this.t('ui.paper'), this.el.paper, this.el.paperHint),
        field(this.t('ui.brightness'), this.el.brightness, this.el.brightnessNote),
        field(this.t('ui.contrast'), this.el.contrast, this.el.contrastNote),
      ),
      this.el.custom,
      h('div', { class: 'ds-row ds-actions' }, this.el.scanBtn, this.el.cancelBtn, this.el.progress),
      this.el.scanMsg,
      this.el.scanError,
    );

    // pages
    this.el.count = h('span', { class: 'ds-count' });
    this.el.removeBlank = h('button', { type: 'button', class: 'ds-btn ds-btn-secondary', hidden: true, onclick: () => this.removeBlankPages() });
    this.el.clearAll = h('button', { type: 'button', class: 'ds-btn ds-btn-danger', hidden: true, onclick: () => this.clearPages() }, this.t('ui.delete_all'));
    this.el.thumbs = h('ol', { class: 'ds-thumbs', 'aria-label': this.t('ui.pages_count', { count: '' }).replace(/[:\s]+$/, '') });
    this.el.empty = h('p', { class: 'ds-empty' }, this.t('ui.no_pages'));
    this.el.viewerImg = h('img', { class: 'ds-viewer-img', alt: '' });
    this.el.viewerInfo = h('p', { class: 'ds-hint' });
    this.el.viewer = h(
      'div',
      { class: 'ds-viewer', hidden: true },
      h('div', { class: 'ds-row' },
        h('button', { type: 'button', class: 'ds-btn ds-btn-icon', 'aria-label': this.t('ui.zoom_out'), title: this.t('ui.zoom_out'), onclick: () => this.setZoom(this.zoom / 1.25) }, '−'),
        h('button', { type: 'button', class: 'ds-btn ds-btn-icon', 'aria-label': this.t('ui.zoom_in'), title: this.t('ui.zoom_in'), onclick: () => this.setZoom(this.zoom * 1.25) }, '+'),
        h('button', { type: 'button', class: 'ds-btn ds-btn-secondary', onclick: () => this.setZoom(1) }, this.t('ui.fit')),
        this.el.viewerInfo,
      ),
      h('div', { class: 'ds-viewer-frame' }, this.el.viewerImg),
    );
    const pagesSection = h(
      'section',
      { class: 'ds-card ds-pages' },
      h('div', { class: 'ds-row' }, this.el.count, this.el.removeBlank, this.el.clearAll),
      h('div', { class: 'ds-pages-body' }, h('div', {}, this.el.empty, this.el.thumbs), this.el.viewer),
    );

    // output
    this.el.filename = h('input', { id: `${id}-filename`, type: 'text', maxlength: 100, autocomplete: 'off', placeholder: this.defaultFilename() });
    this.el.buildBtn = h('button', { type: 'button', class: 'ds-btn ds-btn-secondary', disabled: true, onclick: () => this.makePdf() }, this.t('ui.build_pdf'));
    this.el.previewLink = h('a', { class: 'ds-btn ds-btn-secondary', target: '_blank', rel: 'noopener', hidden: true }, this.t('ui.preview_pdf'));
    this.el.uploadBtn = h('button', { type: 'button', class: 'ds-btn ds-btn-primary', disabled: true, onclick: () => this.finish() }, this.options.output === 'form-file' ? this.t('ui.build_pdf') : this.t('ui.upload'));
    this.el.uploadProgress = h('progress', { class: 'ds-progress', max: 1, value: 0, hidden: true });
    this.el.outMsg = h('p', { id: this.ids.outMsg, class: 'ds-live', role: 'status', 'aria-live': 'polite' });
    this.el.outError = h('div', { class: 'ds-error-slot' });
    this.el.result = h('div', { class: 'ds-result', hidden: true });
    const outputSection = h(
      'section',
      { class: 'ds-card ds-output' },
      h('div', { class: 'ds-field' }, h('label', { for: `${id}-filename` }, this.t('ui.filename')), this.el.filename),
      h('div', { class: 'ds-row ds-actions' }, this.el.buildBtn, this.el.previewLink, this.options.output === 'form-file' ? null : this.el.uploadBtn, this.el.uploadProgress),
      h('p', { class: 'ds-hint' }, this.options.output === 'form-file' ? '' : this.t('ui.upload_privacy')),
      this.el.outMsg,
      this.el.outError,
      this.el.result,
    );

    this.el.diag = h('button', { type: 'button', class: 'ds-link', onclick: () => this.copyDiagnostics() }, this.t('ui.diagnostics'));

    const app = h('div', { class: 'ds-app' }, this.el.banner, statusSection, this.el.settings, pagesSection, outputSection, h('div', { class: 'ds-footer' }, this.el.diag));
    this.root.append(app);
    this.renderPages();
  }

  defaultFilename() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return (this.config.filenamePattern || 'scan-{date}-{time}')
      .replace('{date}', `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`)
      .replace('{time}', `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`);
  }

  /* ---------------- errors ---------------- */

  showError(slot, err, { retry } = {}) {
    const e = toScannerError(err);
    this.state.errors.push({ at: new Date().toISOString(), code: e.code, correlationId: e.correlationId, status: e.status });
    if (this.state.errors.length > 30) this.state.errors.shift();
    slot.replaceChildren();
    const details = h('details', { class: 'ds-details' }, h('summary', {}, this.t('ui.details')), h('pre', {}, e.technical()));
    const copy = h('button', { type: 'button', class: 'ds-link', onclick: async () => {
      await navigator.clipboard?.writeText(e.technical()).catch(() => {});
      copy.textContent = this.t('ui.copied');
    } }, this.t('ui.copy_details'));
    slot.append(
      h('div', { class: 'ds-alert', role: 'alert' },
        h('p', {}, this.errorText(e)),
        e.action && this.messages.actions?.[e.action] ? h('p', { class: 'ds-hint' }, this.messages.actions[e.action]) : null,
        h('div', { class: 'ds-row' }, retry ? h('button', { type: 'button', class: 'ds-btn ds-btn-secondary', onclick: () => { slot.replaceChildren(); retry(); } }, this.t('ui.retry')) : null, copy),
        details,
      ),
    );
    return e;
  }

  clearError(slot) {
    slot.replaceChildren();
  }

  /* ---------------- agent & devices ---------------- */

  setAgentState(state, params = {}) {
    this.state.agent = state;
    this.el.agentState.dataset.state = state;
    this.el.agentState.textContent = this.t(`agent_state.${state}`, params);
    this.el.agentRetry.hidden = state === 'connected' || state === 'checking';
  }

  async connect() {
    this.clearError(this.el.agentError);
    this.el.agentHelp.hidden = true;
    this.el.pairBox.hidden = true;
    this.el.settings.disabled = true;
    this.setAgentState('checking');
    const probe = await this.agent.probe();
    if (probe.state !== 'connected') {
      if (probe.state === 'incompatible') {
        this.setAgentState('incompatible', { version: probe.health.version, required: this.config.agent.minVersion, protocol: this.config.agent.protocol });
      } else {
        this.setAgentState(probe.state);
      }
      this.showInstallHelp(probe.state);
      this.showError(this.el.agentError, probe.error, { retry: () => this.connect() });
      return;
    }
    try {
      if (this.config.agent.pairingMode === 'code') {
        this.setAgentState('pairing');
        await this.pairWithCode();
      } else {
        await this.agent.pairSigned(() => this.uploader.agentToken());
      }
      this.setAgentState('connected', { version: probe.health.version });
      await this.loadDevices();
    } catch (e) {
      this.setAgentState('pairing_failed');
      this.showError(this.el.agentError, e, { retry: () => this.connect() });
    }
  }

  showInstallHelp(state) {
    const box = this.el.agentHelp;
    box.replaceChildren();
    if (state === 'origin_blocked') return;
    const links = [];
    if (this.config.agent.downloadUrl) links.push(h('a', { class: 'ds-btn ds-btn-primary', href: this.config.agent.downloadUrl, rel: 'noopener', target: '_blank' }, this.t('ui.download_agent')));
    else links.push(h('p', {}, this.t('ui.no_download')));
    if (this.config.agent.helpUrl) links.push(h('a', { class: 'ds-link', href: this.config.agent.helpUrl, rel: 'noopener', target: '_blank' }, this.t('ui.install_help')));
    box.append(h('div', { class: 'ds-row' }, ...links), h('p', { class: 'ds-hint' }, this.t('ui.agent_start_hint')));
    box.hidden = false;
  }

  pairWithCode() {
    return new Promise((resolve, reject) => {
      const input = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '\\d{6}', id: `${this.root.id}-code`, dir: 'ltr' });
      const btn = h('button', { type: 'button', class: 'ds-btn ds-btn-primary' }, this.t('ui.pair'));
      const box = this.el.pairBox;
      let req;
      const start = async () => {
        req = await this.agent.requestPairingCode();
        box.replaceChildren(
          h('label', { for: input.id }, this.t('ui.pairing_code_prompt', { url: req.codeLocation })),
          h('div', { class: 'ds-row' }, input, btn),
        );
        box.hidden = false;
        input.focus();
      };
      btn.addEventListener('click', async () => {
        try {
          await this.agent.confirmPairingCode(req.requestId, input.value.trim());
          box.hidden = true;
          resolve();
        } catch (e) {
          if (e.code === 'PAIRING_FAILED') {
            this.showError(this.el.agentError, e);
            // keep the same code after a typo (the agent limits attempts); ask for a new one only when it expired or was burned
            if (e.details?.reason !== 'wrong_code') await start().catch(reject);
            else input.select();
          } else reject(e);
        }
      });
      start().catch(reject);
    });
  }

  async loadDevices() {
    this.clearError(this.el.agentError);
    const { devices, problems } = await this.agent.devices();
    const visible = devices.filter((d) => !d.simulated || this.config.agent.allowSimulator);
    this.state.devices = visible;
    this.el.device.replaceChildren(...visible.map((d) => h('option', { value: d.id }, d.simulated ? `${d.name} (Simulator)` : d.name)));
    if (!visible.length) {
      this.el.deviceState.dataset.state = 'none';
      this.el.deviceState.textContent = this.t('device_state.none');
      const code = problems?.[0]?.code === 'ADAPTER_UNAVAILABLE' || problems?.[0]?.code === 'DRIVER_MISSING' ? problems[0].code : 'NO_DEVICES';
      this.showError(this.el.agentError, new ScannerError(code, 'No devices', { details: { problems } }), { retry: () => this.loadDevices().catch((e) => this.showError(this.el.agentError, e)) });
      return;
    }
    this.el.settings.disabled = false;
    await this.selectDevice(visible[0].id);
  }

  async selectDevice(id) {
    this.state.deviceId = id;
    // the banner follows the selected device so real scans are never labelled as simulated (and vice versa)
    this.el.banner.hidden = !this.state.devices.find((d) => d.id === id)?.simulated;
    this.el.device.value = id;
    this.el.scanBtn.disabled = true;
    this.clearError(this.el.scanError);
    try {
      const caps = await this.agent.capabilities(id);
      this.state.caps = caps;
      const st = caps.status?.state || 'unknown';
      this.el.deviceState.dataset.state = st;
      this.el.deviceState.textContent = this.t(`device_state.${st}`) || st;
      this.el.source.replaceChildren(...caps.sources.map((s) => h('option', { value: s.id }, s.label)));
      this.el.source.disabled = caps.sources.length < 2;
      this.selectSource(caps.sources[0].id);
    } catch (e) {
      this.state.caps = null;
      this.el.deviceState.dataset.state = 'offline';
      this.el.deviceState.textContent = this.t('device_state.unknown');
      this.showError(this.el.scanError, e, { retry: () => this.selectDevice(id) });
    }
  }

  source() {
    return this.state.caps?.sources.find((s) => s.id === this.state.sourceId) || null;
  }

  selectSource(id) {
    this.state.sourceId = id;
    this.el.source.value = id;
    const s = this.source();
    if (!s) return;

    // colour: device modes, plus clearly-labelled software conversions
    const modes = s.colorModes.map((m) => ({ value: m, capture: m, label: this.t(`ui.${m}`) }));
    if (this.config.features?.software_color_conversion) {
      const base = s.colorModes.includes('color') ? 'color' : s.colorModes[0];
      for (const m of ['gray', 'bw']) {
        if (!s.colorModes.includes(m) && (base === 'color' || (base === 'gray' && m === 'bw'))) {
          modes.push({ value: `sw:${m}`, capture: s.colorModes.includes('gray') ? 'gray' : base, label: `${this.t(`ui.${m}`)} ${this.t('ui.software_conversion')}` });
        }
      }
    }
    this.colorModes = modes;
    this.el.color.replaceChildren(...modes.map((m) => h('option', { value: m.value }, m.label)));

    const dpis = resolutionChoices(s.resolutions, this.config.limits?.maxDpi);
    this.el.dpi.replaceChildren(...dpis.map((d) => h('option', { value: d }, `${d} dpi`)));
    const def = dpis.includes(s.defaultResolution) ? s.defaultResolution : dpis.find((d) => d >= 150) || dpis[0];
    if (def) this.el.dpi.value = String(def);
    this.el.dpi.disabled = dpis.length < 2;
    this.updateDpiWarning();

    const papers = s.paperSizes.map((p) => h('option', { value: p.id }, p.id === 'max' ? `${this.t('ui.max_area')} (${p.widthMm} × ${p.heightMm} mm)` : p.label));
    if (s.customArea) papers.push(h('option', { value: 'custom' }, this.t('ui.custom_size')));
    this.el.paper.replaceChildren(...papers);
    const a4 = s.paperSizes.find((p) => p.id === 'a4');
    this.el.paper.value = a4 ? 'a4' : s.paperSizes[0]?.id;
    const min = s.minArea || { widthMm: 1, heightMm: 1 };
    Object.assign(this.el.customW, { min: min.widthMm, max: s.maxArea.widthMm, value: Math.min(210, s.maxArea.widthMm) });
    Object.assign(this.el.customH, { min: min.heightMm, max: s.maxArea.heightMm, value: Math.min(297, s.maxArea.heightMm) });
    this.updatePaper();

    for (const key of ['brightness', 'contrast']) {
      const r = s[key];
      const input = this.el[key];
      const note = this.el[`${key}Note`];
      if (r) {
        Object.assign(input, { min: r.min, max: r.max, step: r.step || 1, value: Math.max(r.min, Math.min(r.max, 0)), disabled: false });
        note.textContent = '';
      } else {
        Object.assign(input, { min: 0, max: 0, value: 0, disabled: true });
        note.textContent = this.t('ui.not_adjustable');
      }
    }
    this.el.scanBtn.disabled = false;
    this.updateScanButton();
  }

  updateDpiWarning() {
    this.el.dpiWarn.hidden = !(Number(this.el.dpi.value) > (this.config.limits?.warnDpi || 300));
  }

  updatePaper() {
    const s = this.source();
    const custom = this.el.paper.value === 'custom';
    this.el.custom.hidden = !custom;
    this.el.paperHint.textContent = s ? this.t('ui.max_area_hint', { w: s.maxArea.widthMm, h: s.maxArea.heightMm }) : '';
  }

  updateScanButton() {
    this.el.scanBtn.textContent = this.pages.length ? this.t('ui.add_pages') : this.t('ui.scan');
  }

  currentSettings({ maxPages } = {}) {
    const s = this.source();
    const color = this.colorModes.find((m) => m.value === this.el.color.value) || this.colorModes[0];
    const paper = this.el.paper.value === 'custom'
      ? { id: 'custom', widthMm: Number(this.el.customW.value), heightMm: Number(this.el.customH.value) }
      : { id: this.el.paper.value };
    const settings = { source: s.id, colorMode: color.capture, resolution: Number(this.el.dpi.value), paper };
    if (s.brightness && Number(this.el.brightness.value) !== 0) settings.brightness = Number(this.el.brightness.value);
    if (s.contrast && Number(this.el.contrast.value) !== 0) settings.contrast = Number(this.el.contrast.value);
    const remaining = (this.options.maxPages || this.config.limits?.maxPages || 100) - this.pages.length;
    settings.maxPages = Math.max(1, Math.min(maxPages || remaining, remaining));
    return { settings, conversion: color.value.startsWith('sw:') ? color.value.slice(3) : null };
  }

  /* ---------------- scanning ---------------- */

  setBusy(busy) {
    this.state.busy = busy;
    this.el.scanBtn.disabled = busy || !this.source();
    this.el.cancelBtn.hidden = !busy;
    this.el.progress.hidden = !busy;
    for (const k of ['device', 'source', 'color', 'dpi', 'paper']) this.el[k].disabled = busy || (k === 'source' && (this.state.caps?.sources.length || 0) < 2);
    this.renderOutputState();
  }

  /**
   * Scan with the current settings. `replaceId` rescans one page in place.
   */
  async scan({ replaceId = null } = {}) {
    if (this.state.busy || !this.source()) return;
    const limit = this.options.maxPages || this.config.limits?.maxPages || 100;
    if (!replaceId && this.pages.length >= limit) {
      this.showError(this.el.scanError, new ScannerError('TOO_MANY_PAGES', 'limit'));
      return;
    }
    this.clearError(this.el.scanError);
    const { settings, conversion } = this.currentSettings({ maxPages: replaceId ? 1 : undefined });
    const abort = new AbortController();
    this.state.scanAbort = abort;
    this.setBusy(true);
    this.el.scanMsg.textContent = this.t('ui.stage_scanning', { n: 1 });
    const correlationId = uuid();
    let insertAt = replaceId ? this.pages.indexOf(replaceId) : this.pages.length;
    let fetchFailed = false;
    let job;
    try {
      job = await this.agent.runJob(this.state.deviceId, settings, {
        signal: abort.signal,
        correlationId,
        timeoutMs: (this.config.timeouts?.scan_seconds || 600) * 1000,
        onProgress: (j) => {
          if (j.state === 'scanning') this.el.scanMsg.textContent = this.t('ui.stage_scanning', { n: j.progress?.page || j.pages.length + 1 });
        },
        onPage: async (j, p) => {
          const meta = { width: p.width, height: p.height, dpi: p.dpi, colorMode: p.colorMode, side: p.side, conversion, simulated: j.simulated, source: settings.source };
          let target;
          if (replaceId) {
            target = this.pages.get(replaceId);
            this.pages.update(replaceId, { status: 'processing', ...meta });
            replaceId = null; // only the first page replaces
          } else {
            target = this.pages.add(meta, insertAt);
          }
          insertAt++;
          const ok = await this.fetchPage(target.id, j, p, conversion);
          if (!ok) fetchFailed = true;
          if (!this.selectedPageId) this.selectPage(target.id);
        },
      });
      if (job.state === 'failed' || job.state === 'cancelled') {
        const err = new ScannerError(job.error?.code || 'UNKNOWN', job.error?.message, { details: job.error?.details, action: job.error?.action, correlationId: job.error?.correlationId || correlationId });
        if (job.state === 'failed') this.showError(this.el.scanError, err, { retry: () => this.scan() });
        else this.el.scanMsg.textContent = this.errorText(err);
      } else {
        this.el.scanMsg.textContent = this.t('ui.pages_count', { count: this.pages.length });
      }
    } catch (e) {
      this.showError(this.el.scanError, e, { retry: () => this.scan() });
      this.el.scanMsg.textContent = '';
    } finally {
      this.state.scanAbort = null;
      this.setBusy(false);
      this.updateScanButton();
      // Images are now held by the page; free the agent's temp files unless a page fetch needs a retry.
      if (job && !fetchFailed) this.agent.deleteJob(job.id).catch(() => {});
      else if (job) this.pendingJob = job;
    }
  }

  async fetchPage(pageId, job, p, conversion) {
    try {
      const blob = await this.agent.pageBlob(job, p);
      const processed = await processScannedImage(blob, { conversion, detectBlank: this.config.features?.blank_page_detection !== false });
      this.pages.update(pageId, { blob: processed.blob, width: processed.width, height: processed.height, blank: processed.blank, status: 'ready', error: null, retry: null });
      return true;
    } catch (e) {
      const err = toScannerError(e, 'IMAGE_READ_FAILED');
      this.pages.update(pageId, { status: 'error', error: err, retry: () => this.fetchPage(pageId, job, p, conversion).then((ok) => ok && this.agent.deleteJob(job.id).catch(() => {})) });
      return false;
    }
  }

  cancelScan() {
    if (!this.state.scanAbort) return;
    if (window.confirm(this.t('ui.cancel_confirm'))) this.state.scanAbort.abort();
  }

  /* ---------------- pages ---------------- */

  selectPage(id) {
    this.selectedPageId = id;
    this.renderViewer();
    for (const li of this.el.thumbs.children) li.classList.toggle('ds-selected', li.dataset.id === id);
  }

  setZoom(z) {
    this.zoom = Math.max(0.25, Math.min(z, 6));
    this.renderViewer();
  }

  renderViewer() {
    const p = this.pages.get(this.selectedPageId);
    this.el.viewer.hidden = !p || !p.url;
    if (!p || !p.url) return;
    const idx = this.pages.indexOf(p.id) + 1;
    this.el.viewerImg.src = p.url;
    this.el.viewerImg.alt = this.t('ui.page_n', { n: idx });
    this.el.viewerImg.style.transform = `rotate(${p.rotation}deg)`;
    this.el.viewerImg.style.width = `${this.zoom * 100}%`;
    this.el.viewerInfo.textContent = `${this.t('ui.page_n', { n: idx })} · ${this.t('ui.image_info', { w: p.width, h: p.height, dpi: p.dpi })} · ${formatBytes(p.blob?.size || 0, this.locale)}`;
  }

  renderPages() {
    const list = this.el.thumbs;
    // keep keyboard focus on the same control of the same page across re-renders
    const active = document.activeElement;
    const focusPage = list.contains(active) ? active.closest('.ds-thumb')?.dataset.id : null;
    const focusAction = focusPage ? active.dataset.action || 'select' : null;
    list.replaceChildren();
    const n = this.pages.length;
    this.el.empty.hidden = n > 0;
    this.el.count.textContent = this.t('ui.pages_count', { count: n }) + (n ? ` · ${formatBytes(this.pages.totalBytes(), this.locale)}` : '');
    this.el.clearAll.hidden = n === 0;
    const blanks = this.pages.pages.filter((p) => p.blank);
    this.el.removeBlank.hidden = blanks.length === 0;
    this.el.removeBlank.textContent = this.t('ui.remove_blank', { count: blanks.length });

    this.pages.pages.forEach((p, i) => {
      const num = i + 1;
      const btn = (label, fn, opts = {}) => h('button', { type: 'button', class: 'ds-btn ds-btn-icon', 'aria-label': `${label} – ${this.t('ui.page_n', { n: num })}`, title: label, disabled: opts.disabled, dataset: { action: opts.action }, onclick: (e) => { e.stopPropagation(); fn(); } }, opts.icon || label);
      const img = p.url
        ? h('img', { src: p.url, alt: this.t('ui.page_n', { n: num }), style: `transform: rotate(${p.rotation}deg)`, loading: 'lazy' })
        : h('span', { class: 'ds-spinner', role: 'img', 'aria-label': this.t('ui.stage_processing') });
      const badges = h('span', { class: 'ds-badges' },
        p.side === 'back' ? h('span', { class: 'ds-tag' }, this.t('ui.back_side')) : null,
        p.blank ? h('span', { class: 'ds-tag ds-tag-warn' }, this.t('ui.blank_suspect')) : null,
        p.conversion ? h('span', { class: 'ds-tag' }, this.t(`ui.${p.conversion}`)) : null,
        p.status === 'error' ? h('span', { class: 'ds-tag ds-tag-error' }, this.errorText(p.error || {})) : null,
      );
      const li = h(
        'li',
        { class: `ds-thumb${p.id === this.selectedPageId ? ' ds-selected' : ''}`, draggable: 'true', dataset: { id: p.id, status: p.status } },
        h('button', {
          type: 'button',
          class: 'ds-thumb-main',
          dataset: { action: 'select' },
          'aria-label': this.t('ui.page_n', { n: num }),
          'aria-current': p.id === this.selectedPageId ? 'true' : null,
          onclick: () => this.selectPage(p.id),
          onkeydown: (e) => {
            if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              e.preventDefault();
              this.pages.move(p.id, e.key === 'ArrowUp' ? -1 : 1);
              this.el.thumbs.querySelector(`[data-id="${p.id}"] .ds-thumb-main`)?.focus();
            }
          },
        }, h('span', { class: 'ds-thumb-img' }, img), h('span', { class: 'ds-thumb-num' }, num)),
        badges,
        h('div', { class: 'ds-thumb-tools' },
          btn(this.t('ui.rotate_left'), () => this.pages.rotate(p.id, -90), { icon: '⟲', action: 'rotl' }),
          btn(this.t('ui.rotate_right'), () => this.pages.rotate(p.id, 90), { icon: '⟳', action: 'rotr' }),
          btn(this.t('ui.move_up'), () => this.pages.move(p.id, -1), { icon: '▲', disabled: i === 0, action: 'up' }),
          btn(this.t('ui.move_down'), () => this.pages.move(p.id, 1), { icon: '▼', disabled: i === n - 1, action: 'down' }),
          p.status === 'error' && p.retry
            ? btn(this.t('ui.retry'), () => p.retry(), { icon: '↻', action: 'retry' })
            : btn(this.t('ui.rescan'), () => this.scan({ replaceId: p.id }), { icon: '⎙', disabled: this.state.busy || !this.source(), action: 'rescan' }),
          btn(this.t('ui.delete'), () => this.deletePage(p.id), { icon: '✕', action: 'delete' }),
        ),
      );
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', p.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragover', (e) => e.preventDefault());
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/plain');
        if (id && id !== p.id) this.pages.moveTo(id, this.pages.indexOf(p.id));
      });
      list.append(li);
    });
    if (focusPage) {
      const li = list.querySelector(`[data-id="${focusPage}"]`);
      const target = li?.querySelector(`[data-action="${focusAction}"]:not([disabled])`) || li?.querySelector('.ds-thumb-main');
      target?.focus();
    }
    if (this.selectedPageId && !this.pages.get(this.selectedPageId)) this.selectedPageId = this.pages.pages[0]?.id || null;
    this.renderViewer();
    this.updateScanButton();
    this.renderOutputState();
  }

  deletePage(id) {
    const n = this.pages.indexOf(id) + 1;
    if (!window.confirm(this.t('ui.delete_page_confirm', { n }))) return;
    this.pages.remove(id);
  }

  removeBlankPages() {
    const ids = this.pages.pages.filter((p) => p.blank).map((p) => p.id);
    if (ids.length && window.confirm(this.t('ui.remove_blank_confirm', { count: ids.length }))) this.pages.removeMany(ids);
  }

  clearPages() {
    if (window.confirm(this.t('ui.delete_all_confirm', { count: this.pages.length }))) {
      this.pages.clear();
      this.resetPdf();
    }
  }

  /* ---------------- PDF & upload ---------------- */

  renderOutputState() {
    const ready = this.pages.ready().length;
    const allReady = ready > 0 && ready === this.pages.length;
    this.el.buildBtn.disabled = !allReady || this.state.busy;
    this.el.uploadBtn.disabled = !allReady || this.state.busy;
    if (this.state.pdf && this.state.pdf.version !== this.pages.version) {
      this.resetPdf();
      if (this.pages.length) this.el.outMsg.textContent = this.t('ui.pdf_stale');
    }
  }

  resetPdf() {
    if (this.state.pdf?.url) URL.revokeObjectURL(this.state.pdf.url);
    this.state.pdf = null;
    this.el.previewLink.hidden = true;
    this.el.previewLink.removeAttribute('href');
    if (this.options.output === 'form-file' && this.output) this.output.value = '';
  }

  async makePdf() {
    this.clearError(this.el.outError);
    const pages = this.pages.pages;
    if (!pages.length || pages.some((p) => p.status !== 'ready')) {
      this.showError(this.el.outError, new ScannerError('NO_PAGES', 'no pages'));
      return null;
    }
    if (this.state.pdf && this.state.pdf.version === this.pages.version) return this.state.pdf;
    this.state.busy = true;
    this.renderOutputState();
    try {
      const rendered = [];
      for (const [i, p] of pages.entries()) {
        this.el.outMsg.textContent = `${this.t('ui.stage_pdf')} (${i + 1}/${pages.length})`;
        try {
          rendered.push(await renderForPdf(p, { quality: this.config.pdf?.jpegQuality, maxPixels: this.config.pdf?.maxImagePixels }));
        } catch (e) {
          throw new ScannerError(e.code === 'OUT_OF_MEMORY' ? 'OUT_OF_MEMORY' : 'PDF_FAILED', e.message, { details: { page: i + 1 } });
        }
      }
      let bytes;
      try {
        bytes = buildPdf(rendered, { title: this.options.title || undefined });
        verifyPdf(bytes, pages.length);
      } catch (e) {
        throw new ScannerError(e.message === 'PDF_PAGE_MISMATCH' ? 'PDF_PAGE_MISMATCH' : 'PDF_FAILED', e.message);
      }
      const max = this.config.limits?.maxFileSizeBytes;
      const blob = new Blob([bytes], { type: 'application/pdf' });
      if (!blob.size) throw new ScannerError('PDF_FAILED', 'empty');
      this.resetPdf();
      this.state.pdf = { blob, url: URL.createObjectURL(blob), pages: pages.length, version: this.pages.version };
      this.el.previewLink.href = this.state.pdf.url;
      this.el.previewLink.hidden = false;
      this.el.outMsg.textContent = this.t('ui.pdf_ready', { pages: pages.length, size: formatBytes(blob.size, this.locale) });
      if (max && blob.size > max) throw new ScannerError('FILE_TOO_LARGE', 'too large', { details: { size: blob.size, max } });
      if (this.options.output === 'form-file') this.attachToForm();
      return this.state.pdf;
    } catch (e) {
      this.showError(this.el.outError, e, { retry: () => this.makePdf() });
      return null;
    } finally {
      this.state.busy = false;
      this.renderOutputState();
    }
  }

  filename() {
    const v = this.el.filename.value.trim();
    return `${(v || this.defaultFilename()).replace(/\.pdf$/i, '')}.pdf`;
  }

  attachToForm() {
    const pdf = this.state.pdf;
    const dt = new DataTransfer();
    dt.items.add(new File([pdf.blob], this.filename(), { type: 'application/pdf' }));
    this.output.files = dt.files;
    this.el.outMsg.textContent = this.t('ui.attached', { pages: pdf.pages, size: formatBytes(pdf.blob.size, this.locale) });
    this.root.dispatchEvent(new CustomEvent('document-scanner:attached', { bubbles: true, detail: { pages: pdf.pages, size: pdf.blob.size } }));
  }

  async finish() {
    const pdf = await this.makePdf();
    if (!pdf || this.options.output === 'form-file') return;
    this.clearError(this.el.outError);
    this.state.busy = true;
    this.renderOutputState();
    this.el.uploadProgress.hidden = false;
    this.el.uploadProgress.value = 0;
    this.el.result.hidden = true;
    try {
      const health = this.agent.health || {};
      const result = await this.uploader.upload(pdf.blob, {
        filename: this.filename(),
        pages: pdf.pages,
        title: this.options.title || undefined,
        category: this.options.category || undefined,
        clientMeta: { agentVersion: health.version, adapter: this.state.devices.find((d) => d.id === this.state.deviceId)?.adapter, simulated: Boolean(this.state.devices.find((d) => d.id === this.state.deviceId)?.simulated) },
        onProgress: (f) => {
          this.el.uploadProgress.value = f;
          this.el.outMsg.textContent = this.t('ui.stage_uploading', { percent: Math.round(f * 100) });
        },
      });
      // Success is only reported after the server confirmed the stored document.
      const doc = result.document;
      this.state.uploaded = doc;
      if (this.output) this.output.value = doc.id;
      this.el.outMsg.textContent = this.t('ui.uploaded', { pages: doc.pages ?? pdf.pages, size: formatBytes(doc.size, this.locale) });
      this.el.result.replaceChildren(h('a', { class: 'ds-btn ds-btn-secondary', href: doc.downloadUrl, target: '_blank', rel: 'noopener' }, this.t('ui.open_document')));
      this.el.result.hidden = false;
      this.root.dispatchEvent(new CustomEvent('document-scanner:uploaded', { bubbles: true, detail: { document: doc } }));
    } catch (e) {
      this.el.outMsg.textContent = '';
      // pages and PDF are kept in memory for a retry
      this.showError(this.el.outError, e, { retry: () => this.finish() });
      this.root.dispatchEvent(new CustomEvent('document-scanner:error', { bubbles: true, detail: { code: toScannerError(e).code } }));
    } finally {
      this.el.uploadProgress.hidden = true;
      this.state.busy = false;
      this.renderOutputState();
    }
  }

  bindForm() {
    if (!this.form || !this.output) return;
    this.form.addEventListener('submit', (e) => {
      if (this.output.dataset.required !== '1') return;
      const empty = this.options.output === 'form-file' ? !this.output.files?.length : !this.output.value;
      if (empty) {
        e.preventDefault();
        this.showError(this.el.outError, new ScannerError('NO_PAGES', 'required'));
        this.el.outError.scrollIntoView?.({ block: 'center' });
      }
    });
  }

  /* ---------------- diagnostics ---------------- */

  async copyDiagnostics() {
    let agentDiag = null;
    try {
      agentDiag = this.agent.session ? await this.agent.diagnostics() : null;
    } catch {
      agentDiag = null;
    }
    const report = {
      generatedAt: new Date().toISOString(),
      page: location.origin + location.pathname,
      userAgent: navigator.userAgent,
      agentUrl: this.config.agent.url,
      required: { protocol: this.config.agent.protocol, minVersion: this.config.agent.minVersion },
      agentState: this.state.agent,
      agentHealth: this.agent.health,
      agentDiagnostics: agentDiag,
      device: this.state.deviceId,
      sources: this.state.caps?.sources.map((s) => ({ id: s.id, colorModes: s.colorModes, resolutions: s.resolutions })),
      pages: this.pages.pages.map((p) => ({ status: p.status, width: p.width, height: p.height, dpi: p.dpi, bytes: p.blob?.size })),
      recentErrors: this.state.errors,
    };
    const text = JSON.stringify(report, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      this.el.diag.textContent = this.t('ui.copied');
    } catch {
      const blob = new Blob([text], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: 'scanner-diagnostics.json' });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  }
}
