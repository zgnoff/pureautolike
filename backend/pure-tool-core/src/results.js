import {ToolCoreError, toolError} from './errors.js';

function metadata(meta = {}) {
  const output = {};
  if (typeof meta.executor === 'string' && meta.executor) output.executor = meta.executor;
  if (typeof meta.requestId === 'string' && meta.requestId) output.requestId = meta.requestId;
  if (typeof meta.capabilityVersion === 'string' && meta.capabilityVersion) {
    output.capabilityVersion = meta.capabilityVersion;
  }
  return output;
}

export function success(data, meta = {}) {
  return Object.freeze({ok: true, data, ...metadata(meta)});
}

export function failure(error, meta = {}) {
  const safe = error instanceof ToolCoreError ? error : toolError('executor_rejected');
  const output = {
    ok: false,
    error: safe.code,
    retryable: safe.retryable,
    ...metadata(meta)
  };
  if (Number.isSafeInteger(safe.retryAfterMs)) output.retryAfterMs = safe.retryAfterMs;
  return Object.freeze(output);
}
