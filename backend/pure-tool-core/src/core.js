import {isToolCoreError, toolError} from './errors.js';
import {authorize} from './policy.js';
import {createRegistry} from './registry.js';
import {failure, success} from './results.js';
import {createRouter} from './router.js';
import {normalizeArgs} from './schema.js';

const REQUEST_ID = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_DEPTH = 8;
const MAX_OUTPUT_KEYS = 100;
const MAX_OUTPUT_ITEMS = 100;
const BEARER_CREDENTIAL = /\bbearer\s+[A-Za-z0-9._~+/=-]+/i;
const PRIVATE_CDN = /private-cdn\.thepure\.app/i;

function defaultRequestId() {
  return `req_${crypto.randomUUID()}`;
}

function optionSnapshot(options) {
  if (!options || (typeof options !== 'object' && typeof options !== 'function')) return Object.freeze({});
  try {
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const output = {};
    for (const key of ['definitions', 'executors', 'confirmationVerifier', 'audit', 'requestId']) {
      const descriptor = descriptors[key];
      if (descriptor && Object.hasOwn(descriptor, 'value')) output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch {
    return Object.freeze({});
  }
}

function credentialKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'authorization' || normalized === 'cookie' || normalized === 'cookies' ||
    normalized === 'setcookie' || normalized === 'documentcookie' || normalized === 'token' ||
    normalized === 'credential' || normalized === 'credentials' || normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('bearer') || normalized.includes('accesstoken') ||
    normalized.includes('refreshtoken') || normalized.includes('sessiontoken') ||
    normalized.includes('apikey') || normalized.includes('protectedurl') ||
    normalized.includes('privateurl') || normalized.includes('signedurl');
}

function unsafeString(value) {
  return BEARER_CREDENTIAL.test(value) || PRIVATE_CDN.test(value) || /\bsk_?live[A-Za-z0-9_-]+/i.test(value);
}

function rejectOutput(code = 'executor_rejected') {
  throw toolError(code);
}

function snapshotOutputValue(value, visiting, depth = 0) {
  if (depth > MAX_OUTPUT_DEPTH) rejectOutput();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (unsafeString(value)) rejectOutput();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) rejectOutput();
    return value;
  }
  if (typeof value !== 'object' || visiting.has(value)) rejectOutput();
  visiting.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(descriptors).length > 0) rejectOutput();

    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) rejectOutput();
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value')
        ? lengthDescriptor.value
        : -1;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_OUTPUT_ITEMS) rejectOutput();
      const enumerableKeys = Object.entries(descriptors)
        .filter(([, descriptor]) => descriptor.enumerable)
        .map(([key]) => key);
      if (enumerableKeys.length !== length) rejectOutput();
      const output = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) rejectOutput();
        output[index] = snapshotOutputValue(descriptor.value, visiting, depth + 1);
      }
      return Object.freeze(output);
    }

    if (prototype !== Object.prototype && prototype !== null) rejectOutput();
    const entries = Object.entries(descriptors).filter(([, descriptor]) => descriptor.enumerable);
    if (entries.length > MAX_OUTPUT_KEYS) rejectOutput();
    const output = {};
    for (const [key, descriptor] of entries) {
      if (!Object.hasOwn(descriptor, 'value') || credentialKey(key)) rejectOutput();
      Object.defineProperty(output, key, {
        value: snapshotOutputValue(descriptor.value, visiting, depth + 1),
        enumerable: true,
        writable: false,
        configurable: false
      });
    }
    return Object.freeze(output);
  } catch (error) {
    if (isToolCoreError(error)) throw error;
    rejectOutput();
  } finally {
    visiting.delete(value);
  }
}

function snapshotOutput(value) {
  try {
    const output = snapshotOutputValue(value, new WeakSet());
    const serialized = JSON.stringify(output);
    if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > MAX_OUTPUT_BYTES) {
      rejectOutput('result_too_large');
    }
    return output;
  } catch (error) {
    if (isToolCoreError(error) && error.code === 'result_too_large') throw toolError('result_too_large');
    throw toolError('executor_rejected');
  }
}

function normalizeOutput(value, schema) {
  const snapshot = snapshotOutput(value);
  try {
    return normalizeArgs(snapshot, schema);
  } catch {
    throw toolError('executor_rejected');
  }
}

function safeCallerType(context) {
  try {
    if (!context || (typeof context !== 'object' && typeof context !== 'function')) return 'system';
    const descriptor = Object.getOwnPropertyDescriptor(context, 'callerType');
    const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
    return ['mcp', 'app', 'telegram', 'system'].includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function createToolCore(options = {}) {
  const snapshot = optionSnapshot(options);
  const registry = createRegistry(Object.hasOwn(snapshot, 'definitions') ? snapshot.definitions : []);
  const router = createRouter({executors: snapshot.executors});
  const confirmationVerifier = typeof snapshot.confirmationVerifier === 'function'
    ? snapshot.confirmationVerifier
    : undefined;
  const audit = typeof snapshot.audit === 'function' ? snapshot.audit : () => {};
  const requestId = typeof snapshot.requestId === 'function' ? snapshot.requestId : defaultRequestId;

  function nextRequestId() {
    try {
      const supplied = requestId();
      if (typeof supplied === 'string' && REQUEST_ID.test(supplied) && !credentialKey(supplied)) return supplied;
    } catch {}
    try {
      const generated = defaultRequestId();
      return REQUEST_ID.test(generated) && !credentialKey(generated) ? generated : 'req_unavailable';
    } catch {
      return 'req_unavailable';
    }
  }

  async function capabilities() {
    return registry.capabilities(await router.health());
  }

  async function invoke(name, rawArgs = {}, context = {}) {
    const started = Date.now();
    const id = nextRequestId();
    const definition = registry.get(name);
    let executor = 'core';
    let result;
    try {
      if (!definition) throw toolError('operation_not_found');
      const args = normalizeArgs(rawArgs, definition.inputSchema);
      await authorize(definition, args, context, confirmationVerifier);
      if (!definition.implemented) throw toolError('capability_not_implemented');
      if (definition.name === 'system.capabilities.list') {
        result = success(normalizeOutput(await capabilities(), definition.outputSchema), {
          executor, requestId: id, capabilityVersion: definition.schemaVersion
        });
      } else {
        const routed = await router.execute(definition, args, context, attempted => { executor = attempted; });
        executor = routed.executor;
        result = success(normalizeOutput(routed.data, definition.outputSchema), {
          executor, requestId: id, capabilityVersion: definition.schemaVersion
        });
      }
    } catch (error) {
      const safe = isToolCoreError(error) ? error : toolError('executor_rejected');
      result = failure(safe, {executor, requestId: id, capabilityVersion: definition?.schemaVersion});
    }
    const event = Object.freeze({
      requestId: id,
      tool: definition?.name || 'invalid',
      schemaVersion: definition?.schemaVersion || 'unknown',
      callerType: safeCallerType(context),
      executor,
      resultCode: result.ok ? 'ok' : result.error,
      durationMs: Math.max(0, Date.now() - started),
      confirmation: definition?.confirmation || 'none'
    });
    try {
      setTimeout(() => {
        try {
          Promise.resolve(Reflect.apply(audit, undefined, [event])).catch(() => {});
        } catch {}
      }, 0);
    } catch {}
    return result;
  }

  return Object.freeze({invoke, capabilities, health: router.health});
}
