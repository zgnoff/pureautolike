import {ToolCoreError, toolError} from './errors.js';

const ALLOWED = new Set(['gateway', 'extension']);

function offlineCode(name) {
  return name === 'extension' ? 'extension_offline' : 'gateway_offline';
}

export function createRouter({executors = {}} = {}) {
  const available = Object.fromEntries(
    Object.entries(executors).filter(([name, value]) =>
      ALLOWED.has(name) && value && typeof value.health === 'function' && typeof value.execute === 'function'
    )
  );

  async function health() {
    const output = {};
    for (const name of ALLOWED) {
      if (!available[name]) output[name] = 'offline';
      else {
        try { output[name] = await available[name].health(); }
        catch (_) { output[name] = 'offline'; }
      }
    }
    return Object.freeze(output);
  }

  async function candidates(definition, context) {
    const states = await health();
    const declared = definition.executors.filter(name => ALLOWED.has(name));
    const preferred = context.preferredExecutor;
    const ordered = preferred && declared.includes(preferred)
      ? [preferred, ...declared.filter(name => name !== preferred)]
      : ['gateway', 'extension'].filter(name => declared.includes(name));
    return {states, ordered};
  }

  return Object.freeze({
    health,
    async execute(definition, args, context = {}) {
      const {states, ordered} = await candidates(definition, context);
      let lastOffline = null;
      for (let index = 0; index < ordered.length; index += 1) {
        const name = ordered[index];
        if (states[name] !== 'online') {
          lastOffline = toolError(offlineCode(name), {retryable: true});
          continue;
        }
        try {
          const data = await available[name].execute(definition.name, args, context);
          return Object.freeze({executor: name, data});
        } catch (error) {
          const safeOffline = error instanceof ToolCoreError && error.code === offlineCode(name);
          if (!definition.safeFailover || !safeOffline || index === ordered.length - 1) throw error;
          lastOffline = error;
        }
      }
      throw lastOffline || toolError(definition.executors.includes('extension') ? 'extension_offline' : 'gateway_offline', {retryable: true});
    }
  });
}
