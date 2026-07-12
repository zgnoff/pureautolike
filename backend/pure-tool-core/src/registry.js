import {toolError} from './errors.js';

const NAME = /^(?:pure|extension|system)(?:\.[a-z][a-z0-9_]*){2,5}$/;
const EXECUTORS = new Set(['core', 'gateway', 'extension']);
const CONFIRMATIONS = new Set(['none', 'grant', 'dangerous']);
const MUTATIONS = new Set(['read', 'idempotent', 'non_idempotent', 'destructive']);

function reject() {
  throw toolError('invalid_input');
}

function validate(definition) {
  if (!definition || typeof definition !== 'object' || !NAME.test(definition.name)) reject();
  if (definition.schemaVersion !== '1' || !Array.isArray(definition.executors) || definition.executors.length === 0) reject();
  if (!definition.executors.every(value => EXECUTORS.has(value))) reject();
  if (!Array.isArray(definition.scopes) || !CONFIRMATIONS.has(definition.confirmation)) reject();
  if (!MUTATIONS.has(definition.mutation) || !definition.inputSchema) reject();
  if (definition.mutation === 'destructive' && definition.confirmation !== 'dangerous') reject();
  if (definition.safeFailover && definition.mutation !== 'read' && definition.mutation !== 'idempotent') reject();
  return definition;
}

export function createRegistry(definitions) {
  if (!Array.isArray(definitions)) reject();
  const indexed = new Map();
  for (const definition of definitions) {
    validate(definition);
    if (indexed.has(definition.name)) reject();
    indexed.set(definition.name, definition);
  }
  const list = Object.freeze([...indexed.values()].sort((a, b) => a.name.localeCompare(b.name)));
  return Object.freeze({
    get(name) { return indexed.get(name) || null; },
    list() { return list; },
    capabilities(health = {}) {
      return list.map(definition => {
        let availability = 'available';
        if (!definition.implemented) availability = 'not_implemented';
        else if (!definition.executors.includes('core') && !definition.executors.some(name => health[name] === 'online')) {
          availability = definition.executors.includes('extension') ? 'extension_offline' : 'gateway_offline';
        }
        return Object.freeze({
          name: definition.name,
          schemaVersion: definition.schemaVersion,
          executors: definition.executors,
          scopes: definition.scopes,
          confirmation: definition.confirmation,
          availability
        });
      });
    }
  });
}
