const CODES = [
  'invalid_input',
  'permission_denied',
  'confirmation_required',
  'extension_offline',
  'gateway_offline',
  'reauth_required',
  'capability_not_implemented',
  'provider_rate_limited',
  'provider_rejected',
  'media_expired',
  'compatibility_required',
  'result_too_large',
  'operation_uncertain',
  'operation_not_found',
  'executor_rejected'
];

export const ERROR_CODES = new Set(CODES);

export class ToolCoreError extends Error {
  constructor(code, {retryable = false, retryAfterMs = null, cause} = {}) {
    if (!ERROR_CODES.has(code)) throw new TypeError('Unknown tool-core error code');
    super(code, cause ? {cause} : undefined);
    this.name = 'ToolCoreError';
    this.code = code;
    this.retryable = retryable === true;
    if (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs = retryAfterMs;
  }
}

export function toolError(code, options) {
  return new ToolCoreError(code, options);
}
