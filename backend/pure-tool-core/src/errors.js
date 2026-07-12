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
const TOOL_CORE_ERRORS = new WeakSet();

function rejectMutation() {
  throw new TypeError('ERROR_CODES is read-only');
}

export const ERROR_CODES = Object.freeze({
  get size() {
    return VALID_ERROR_CODES.size;
  },
  has(code) {
    return VALID_ERROR_CODES.has(code);
  },
  keys() {
    return VALID_ERROR_CODES.keys();
  },
  values() {
    return VALID_ERROR_CODES.values();
  },
  entries() {
    return VALID_ERROR_CODES.entries();
  },
  forEach(callback, thisArg) {
    VALID_ERROR_CODES.forEach((value) => {
      callback.call(thisArg, value, value, ERROR_CODES);
    });
  },
  [Symbol.iterator]() {
    return VALID_ERROR_CODES[Symbol.iterator]();
  },
  add: rejectMutation,
  delete: rejectMutation,
  clear: rejectMutation,
  valueOf() {
    return ERROR_CODES;
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
    TOOL_CORE_ERRORS.add(this);
  }
}

export function isToolCoreError(value) {
  return TOOL_CORE_ERRORS.has(value);
}

export function toolError(code, options) {
  return new ToolCoreError(code, options);
}
