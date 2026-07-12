import {ToolCoreError, toolError} from './errors.js';
import {authorize} from './policy.js';
import {createRegistry} from './registry.js';
import {failure, success} from './results.js';
import {createRouter} from './router.js';
import {normalizeArgs} from './schema.js';

function defaultRequestId() {
  return `req_${crypto.randomUUID()}`;
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
  const registry = createRegistry(options.definitions || []);
  const router = createRouter({executors: options.executors});
  const confirmationVerifier = options.confirmationVerifier;
  const audit = typeof options.audit === 'function' ? options.audit : () => {};
  const requestId = typeof options.requestId === 'function' ? options.requestId : defaultRequestId;

  function nextRequestId() {
    try {
      const supplied = requestId();
      if (typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 128) return supplied;
    } catch {}
    try {
      return defaultRequestId();
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
        result = success(await capabilities(), {
          executor, requestId: id, capabilityVersion: definition.schemaVersion
        });
      } else {
        const routed = await router.execute(definition, args, context);
        executor = routed.executor;
        result = success(routed.data, {
          executor, requestId: id, capabilityVersion: definition.schemaVersion
        });
      }
    } catch (error) {
      const safe = error instanceof ToolCoreError ? error : toolError('executor_rejected');
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
    try { await audit(event); } catch (_) {}
    return result;
  }

  return Object.freeze({invoke, capabilities, health: router.health});
}
