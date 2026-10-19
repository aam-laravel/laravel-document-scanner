/**
 * Unified error model shared by the agent, the browser client and the Laravel
 * package. `code` values are stable identifiers; `message` is a safe English
 * fallback (the browser translates by code); `details` must never contain
 * document content, tokens or secrets.
 */
export const ErrorCodes = Object.freeze({
  // transport / security
  ORIGIN_NOT_ALLOWED: 403,
  HOST_NOT_ALLOWED: 403,
  PAIRING_REQUIRED: 401,
  PAIRING_FAILED: 401,
  SESSION_EXPIRED: 401,
  RATE_LIMITED: 429,
  INVALID_REQUEST: 400,
  REPLAYED_REQUEST: 409,
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
  // devices
  ADAPTER_UNAVAILABLE: 503,
  NO_DEVICES: 404,
  DEVICE_NOT_FOUND: 404,
  DEVICE_BUSY: 409,
  DEVICE_OFFLINE: 503,
  DEVICE_OPEN_FAILED: 503,
  PERMISSION_DENIED: 403,
  DRIVER_ERROR: 502,
  DRIVER_MISSING: 503,
  UNSUPPORTED_FEATURE: 422,
  UNSUPPORTED_SETTING: 422,
  SOURCE_UNAVAILABLE: 422,
  // paper path / hardware
  FEEDER_EMPTY: 409,
  PAPER_JAM: 409,
  PAPER_FEED_FAILED: 409,
  COVER_OPEN: 409,
  HARDWARE_ERROR: 502,
  WARMING_UP: 503,
  // job
  JOB_NOT_FOUND: 404,
  SCAN_CANCELLED: 409,
  SCAN_TIMEOUT: 504,
  IMAGE_READ_FAILED: 502,
  TOO_MANY_PAGES: 422,
  OUT_OF_MEMORY: 507,
  DISK_FULL: 507,
  INTERNAL_ERROR: 500,
});

const ACTIONS = {
  FEEDER_EMPTY: 'load_paper',
  PAPER_JAM: 'clear_jam',
  PAPER_FEED_FAILED: 'clear_jam',
  COVER_OPEN: 'close_cover',
  DEVICE_BUSY: 'wait_retry',
  DEVICE_OFFLINE: 'check_connection',
  DEVICE_OPEN_FAILED: 'check_connection',
  DRIVER_MISSING: 'install_driver',
  DRIVER_ERROR: 'reinstall_driver',
  PAIRING_REQUIRED: 'pair',
  SESSION_EXPIRED: 'pair',
  ORIGIN_NOT_ALLOWED: 'configure_origin',
  WARMING_UP: 'wait_retry',
  SCAN_TIMEOUT: 'retry',
  DISK_FULL: 'free_space',
};

export class AgentError extends Error {
  constructor(code, message, details = undefined) {
    super(message || code);
    this.code = ErrorCodes[code] ? code : 'INTERNAL_ERROR';
    this.status = ErrorCodes[this.code];
    this.details = details;
  }

  toJSON(correlationId) {
    const body = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    if (ACTIONS[this.code]) body.action = ACTIONS[this.code];
    if (correlationId) body.correlationId = correlationId;
    return body;
  }
}

/** Normalise anything thrown into an AgentError without leaking internals. */
export function toAgentError(err) {
  if (err instanceof AgentError) return err;
  if (err && (err.code === 'ENOSPC' || err.code === 'EDQUOT')) {
    return new AgentError('DISK_FULL', 'Not enough disk space for temporary scan files.');
  }
  if (err && err.code === 'ENOMEM') {
    return new AgentError('OUT_OF_MEMORY', 'The agent ran out of memory.');
  }
  return new AgentError('INTERNAL_ERROR', 'Unexpected agent error.');
}
