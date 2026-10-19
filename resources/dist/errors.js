/**
 * Unified client-side error. `code` matches the agent / Laravel error codes;
 * user-facing text is looked up by code in the translated messages.
 */
export class ScannerError extends Error {
  constructor(code, message = code, { details, action, correlationId, status, fields } = {}) {
    super(message);
    this.name = 'ScannerError';
    this.code = code;
    this.details = details;
    this.action = action;
    this.correlationId = correlationId;
    this.status = status;
    this.fields = fields;
  }

  /** Safe technical summary for the "details" panel (never includes tokens). */
  technical() {
    return JSON.stringify(
      { code: this.code, status: this.status, correlationId: this.correlationId, action: this.action, details: this.details, fields: this.fields, message: this.message },
      null,
      2,
    );
  }
}

export function toScannerError(err, fallback = 'UNKNOWN') {
  if (err instanceof ScannerError) return err;
  if (err && err.name === 'AbortError') return new ScannerError('SCAN_CANCELLED', 'Aborted');
  if (err && err.name === 'TimeoutError') return new ScannerError('SCAN_TIMEOUT', 'Timed out');
  return new ScannerError(fallback, err && err.message ? err.message : String(err));
}

/** Build from an `{error: {...}}` JSON body (agent and Laravel share the shape). */
export function fromErrorBody(body, status, fallback = 'UNKNOWN') {
  const e = body && body.error && typeof body.error === 'object' ? body.error : null;
  if (e && typeof e.code === 'string') {
    return new ScannerError(e.code, e.message || e.code, { details: e.details, action: e.action, correlationId: e.correlationId, status, fields: e.fields });
  }
  // Laravel default validation / auth responses
  if (status === 422 && body && body.errors) return new ScannerError('VALIDATION_FAILED', body.message || 'Invalid', { status, fields: body.errors });
  return new ScannerError(fallback, (body && body.message) || `HTTP ${status}`, { status });
}

export function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
