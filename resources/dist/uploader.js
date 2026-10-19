import { ScannerError, fromErrorBody, uuid } from './errors.js';

const STATUS_CODES = { 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'SESSION_CLOSED', 413: 'FILE_TOO_LARGE', 419: 'CSRF_MISMATCH', 422: 'VALIDATION_FAILED', 429: 'RATE_LIMITED', 507: 'STORAGE_FAILED' };

export function errorForResponse(status, body) {
  if (status === 0) return new ScannerError('NETWORK_ERROR', 'Network error', { status });
  return fromErrorBody(body, status, STATUS_CODES[status] || 'UPLOAD_FAILED');
}

/**
 * Talks to the Laravel endpoints. Uses the session cookie + CSRF token
 * (same-origin). Uploads use XMLHttpRequest for real upload progress.
 * One server "scan session" is reused across retries: the server treats
 * the session as the idempotency key, so a retry never creates duplicates.
 */
export class Uploader {
  constructor({ endpoints, csrfToken, uploadTimeoutMs = 300000, fetch: f, xhr }) {
    this.endpoints = endpoints;
    this.csrfToken = csrfToken;
    this.uploadTimeoutMs = uploadTimeoutMs;
    this.fetch = f || globalThis.fetch.bind(globalThis);
    this.makeXhr = xhr || (() => new XMLHttpRequest());
    this.session = null;
  }

  headers(correlationId) {
    return { Accept: 'application/json', 'X-CSRF-TOKEN': this.csrfToken, 'X-Requested-With': 'XMLHttpRequest', 'X-Correlation-Id': correlationId };
  }

  async json(method, url, body, correlationId = uuid()) {
    let r;
    try {
      r = await this.fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { ...this.headers(correlationId), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ScannerError('NETWORK_ERROR', 'Network error', { correlationId });
    }
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const e = errorForResponse(r.status, data);
      e.correlationId ??= correlationId;
      throw e;
    }
    return data;
  }

  /** Short-lived agent pairing token (signed mode). */
  agentToken() {
    return this.json('POST', this.endpoints.token, {});
  }

  async ensureSession(clientMeta) {
    if (this.session && this.session.status === 'open' && Date.parse(this.session.expiresAt) > Date.now() + 30000) return this.session;
    this.session = await this.json('POST', this.endpoints.sessions, { client: clientMeta });
    return this.session;
  }

  async cancelSession() {
    if (!this.session || this.session.status !== 'open') return;
    await this.json('DELETE', this.session.cancelUrl).catch(() => {});
    this.session = null;
  }

  /**
   * @returns {Promise<{document: object, duplicate: boolean}>}
   */
  async upload(blob, { filename, pages, title, category, clientMeta, onProgress, correlationId = uuid() } = {}) {
    let session = await this.ensureSession(clientMeta);
    try {
      await this.json('POST', session.preflightUrl, { size: blob.size, pages, mimeType: blob.type || 'application/pdf' }, correlationId);
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED' || e.code === 'SESSION_CLOSED') {
        this.session = null;
        session = await this.ensureSession(clientMeta);
      } else throw e;
    }

    const form = new FormData();
    form.append('document', blob, filename || 'scan.pdf');
    if (filename) form.append('filename', filename);
    if (pages) form.append('pages', String(pages));
    if (title) form.append('title', title);
    if (category) form.append('category', category);

    const result = await new Promise((resolve, reject) => {
      const xhr = this.makeXhr();
      xhr.open('POST', session.uploadUrl);
      xhr.timeout = this.uploadTimeoutMs;
      xhr.withCredentials = false; // same-origin: cookies are sent anyway
      for (const [k, v] of Object.entries(this.headers(correlationId))) xhr.setRequestHeader(k, v);
      if (xhr.upload) {
        xhr.upload.onprogress = (ev) => ev.lengthComputable && onProgress?.(ev.loaded / ev.total);
      }
      xhr.onload = () => {
        let body = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON error page */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body && body.document && body.document.id) resolve(body);
        else {
          const e = errorForResponse(xhr.status || 0, body);
          e.correlationId ??= correlationId;
          reject(e);
        }
      };
      xhr.onerror = () => reject(new ScannerError('NETWORK_ERROR', 'Network error', { correlationId }));
      xhr.ontimeout = () => reject(new ScannerError('NETWORK_ERROR', 'Upload timed out', { correlationId }));
      xhr.send(form);
    });
    this.session = result.session;
    return { document: result.document, duplicate: Boolean(result.duplicate) };
  }
}
