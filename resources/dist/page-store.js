/**
 * In-memory page list (never persisted to localStorage: scans can be large
 * and sensitive). Holds image Blobs plus per-page edits. `version` changes on
 * every edit so a built PDF can be detected as stale.
 */
export class PageStore {
  constructor({ createUrl = (b) => URL.createObjectURL(b), revokeUrl = (u) => URL.revokeObjectURL(u) } = {}) {
    this.pages = [];
    this.version = 0;
    this.seq = 0;
    this.listeners = new Set();
    this.createUrl = createUrl;
    this.revokeUrl = revokeUrl;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.version++;
    for (const fn of this.listeners) fn(this);
  }

  get length() {
    return this.pages.length;
  }

  get(id) {
    return this.pages.find((p) => p.id === id) || null;
  }

  indexOf(id) {
    return this.pages.findIndex((p) => p.id === id);
  }

  /** Add a placeholder (status "processing") so the UI can show progress immediately. */
  add(data = {}, index = this.pages.length) {
    const page = { id: `p${++this.seq}`, rotation: 0, status: 'processing', blank: false, url: null, blob: null, ...data };
    if (page.blob) page.url = this.createUrl(page.blob);
    this.pages.splice(Math.max(0, Math.min(index, this.pages.length)), 0, page);
    this.emit();
    return page;
  }

  update(id, data) {
    const page = this.get(id);
    if (!page) return null;
    if (data.blob && data.blob !== page.blob) {
      if (page.url) this.revokeUrl(page.url);
      data = { ...data, url: this.createUrl(data.blob) };
    }
    Object.assign(page, data);
    this.emit();
    return page;
  }

  remove(id) {
    const i = this.indexOf(id);
    if (i < 0) return false;
    const [page] = this.pages.splice(i, 1);
    if (page.url) this.revokeUrl(page.url);
    this.emit();
    return true;
  }

  removeMany(ids) {
    const set = new Set(ids);
    for (const p of this.pages) if (set.has(p.id) && p.url) this.revokeUrl(p.url);
    this.pages = this.pages.filter((p) => !set.has(p.id));
    this.emit();
  }

  move(id, delta) {
    const i = this.indexOf(id);
    return i < 0 ? false : this.moveTo(id, i + delta);
  }

  moveTo(id, index) {
    const i = this.indexOf(id);
    const j = Math.max(0, Math.min(index, this.pages.length - 1));
    if (i < 0 || i === j) return false;
    const [page] = this.pages.splice(i, 1);
    this.pages.splice(j, 0, page);
    this.emit();
    return true;
  }

  rotate(id, degrees) {
    const page = this.get(id);
    if (!page) return null;
    page.rotation = (((page.rotation + degrees) % 360) + 360) % 360;
    this.emit();
    return page;
  }

  clear() {
    for (const p of this.pages) if (p.url) this.revokeUrl(p.url);
    this.pages = [];
    this.emit();
  }

  ready() {
    return this.pages.filter((p) => p.status === 'ready');
  }

  totalBytes() {
    return this.pages.reduce((n, p) => n + (p.blob ? p.blob.size : 0), 0);
  }
}
