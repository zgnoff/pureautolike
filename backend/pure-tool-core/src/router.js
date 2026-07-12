import {ERROR_CODES, toolError} from './errors.js';

const EXECUTOR_NAMES = Object.freeze(['gateway', 'extension']);
const ALLOWED_EXECUTORS = new Set(EXECUTOR_NAMES);
const HEALTH_STATES = new Set(['online', 'offline', 'reauth_required', 'compatibility_required']);

function offlineCode(name) {
  return name === 'extension' ? 'extension_offline' : 'gateway_offline';
}

function ownDataDescriptor(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor : null;
}

function snapshotExecutor(value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return null;
  try {
    const health = ownDataDescriptor(value, 'health');
    const execute = ownDataDescriptor(value, 'execute');
    if (typeof health?.value !== 'function' || typeof execute?.value !== 'function') return null;
    return Object.freeze({health: health.value, execute: execute.value});
  } catch {
    return null;
  }
}

function snapshotExecutors(options) {
  const available = Object.create(null);
  if ((typeof options !== 'object' || options === null) && typeof options !== 'function') return available;
  let executors;
  try {
    const descriptor = ownDataDescriptor(options, 'executors');
    executors = descriptor?.value;
  } catch {
    return available;
  }
  if ((typeof executors !== 'object' || executors === null) && typeof executors !== 'function') return available;
  for (const name of EXECUTOR_NAMES) {
    try {
      const descriptor = ownDataDescriptor(executors, name);
      const executor = descriptor && snapshotExecutor(descriptor.value);
      if (executor) available[name] = executor;
    } catch {
      // A malformed executor is indistinguishable from an unavailable executor.
    }
  }
  return available;
}

function snapshotPreferredExecutor(context) {
  if (context === undefined) return null;
  if ((typeof context !== 'object' || context === null) && typeof context !== 'function') {
    throw toolError('invalid_input');
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(context, 'preferredExecutor');
    if (!descriptor) return null;
    if (!Object.hasOwn(descriptor, 'value')) throw toolError('invalid_input');
    if (!ALLOWED_EXECUTORS.has(descriptor.value)) throw toolError('invalid_input');
    return descriptor.value;
  } catch {
    throw toolError('invalid_input');
  }
}

function canonicalExecutorError(error) {
  try {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') {
      return toolError('executor_rejected');
    }
    const descriptors = Object.getOwnPropertyDescriptors(error);
    const code = descriptors.code;
    if (!code || !Object.hasOwn(code, 'value') || typeof code.value !== 'string' || !ERROR_CODES.has(code.value)) {
      return toolError('executor_rejected');
    }
    const retryable = descriptors.retryable;
    const retryAfterMs = descriptors.retryAfterMs;
    const options = {
      retryable: Boolean(retryable && Object.hasOwn(retryable, 'value') && retryable.value === true)
    };
    if (retryAfterMs && Object.hasOwn(retryAfterMs, 'value') &&
        Number.isSafeInteger(retryAfterMs.value) && retryAfterMs.value >= 0) {
      options.retryAfterMs = retryAfterMs.value;
    }
    return toolError(code.value, options);
  } catch {
    return toolError('executor_rejected');
  }
}

export function createRouter(options = {}) {
  const available = snapshotExecutors(options);

  async function health() {
    const output = {};
    for (const name of EXECUTOR_NAMES) {
      let state = 'offline';
      if (available[name]) {
        try {
          const supplied = await available[name].health();
          if (typeof supplied === 'string' && HEALTH_STATES.has(supplied)) state = supplied;
        } catch {
          state = 'offline';
        }
      }
      output[name] = state;
    }
    return Object.freeze(output);
  }

  async function candidates(definition, preferred) {
    const states = await health();
    const declared = definition.executors.filter(name => ALLOWED_EXECUTORS.has(name));
    const normal = EXECUTOR_NAMES.filter(name => declared.includes(name));
    const ordered = preferred && declared.includes(preferred) && states[preferred] === 'online'
      ? [preferred, ...normal.filter(name => name !== preferred)]
      : normal;
    return {states, ordered};
  }

  return Object.freeze({
    health,
    async execute(definition, args, context = {}) {
      const preferred = snapshotPreferredExecutor(context);
      const {states, ordered} = await candidates(definition, preferred);
      let primaryFailure = null;

      for (let index = 0; index < ordered.length; index += 1) {
        const name = ordered[index];
        const state = states[name];
        if (state !== 'online') {
          const failure = state === 'reauth_required' || state === 'compatibility_required'
            ? toolError(state)
            : toolError(offlineCode(name), {retryable: true});
          if (index === 0) {
            primaryFailure = failure;
            if (state !== 'offline' || !definition.safeFailover) throw failure;
            continue;
          }
          throw primaryFailure || failure;
        }

        try {
          const data = await available[name].execute(definition.name, args, context);
          return Object.freeze({executor: name, data});
        } catch (error) {
          const failure = canonicalExecutorError(error);
          if (index === 0) primaryFailure = failure;
          const safeOffline = failure.code === offlineCode(name);
          if (!definition.safeFailover || !safeOffline || index === ordered.length - 1) throw failure;
        }
      }

      throw primaryFailure || toolError(
        definition.executors.includes('extension') ? 'extension_offline' : 'gateway_offline',
        {retryable: true}
      );
    }
  });
}
