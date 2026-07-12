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

const VALID_ERROR_CODES = new Set(CODES);
const PUBLISHED_ERROR_CODES = new Set(CODES);

function rejectMutation() {
  throw new TypeError('ERROR_CODES is read-only');
}

export const ERROR_CODES = new Proxy(PUBLISHED_ERROR_CODES, {
  get(target, property) {
    if (property === 'add' || property === 'delete' || property === 'clear') {
      return rejectMutation;
    }
    if (property === 'forEach') {
      return (callback, thisArg) => target.forEach((value) => {
        callback.call(thisArg, value, value, ERROR_CODES);
      });
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }
});

export class ToolCoreError extends Error {
  constructor(code, {retryable = false, retryAfterMs = null} = {}) {
    if (!VALID_ERROR_CODES.has(code)) throw new TypeError('Unknown tool-core error code');
    super(code);
    this.name = 'ToolCoreError';
    this.code = code;
    this.retryable = retryable === true;
    if (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs = retryAfterMs;
  }
}

export function toolError(code, options) {
  return new ToolCoreError(code, options);
}
