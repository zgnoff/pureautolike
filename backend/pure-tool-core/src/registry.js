import {toolError} from './errors.js';

const NAME = /^(?:pure|extension|system)(?:\.[a-z][a-z0-9_]*){2,5}$/;
const EXECUTORS = new Set(['core', 'gateway', 'extension']);
const CONFIRMATIONS = new Set(['none', 'grant', 'dangerous']);
const MUTATIONS = new Set(['read', 'idempotent', 'non_idempotent', 'destructive']);
const SCOPE = /^[a-z][a-z0-9]*(?::[a-z][a-z0-9_]*)+$/;
const FIELDS = [
  'name', 'schemaVersion', 'description', 'executors', 'scopes',
  'confirmation', 'mutation', 'safeFailover', 'implemented', 'inputSchema', 'outputSchema'
];
const MAX_SNAPSHOT_DEPTH = 32;
const MAX_SNAPSHOT_NODES = 2_000;

function reject() {
  throw toolError('invalid_input');
}

function ownData(descriptors, key) {
  const descriptor = descriptors[key];
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) reject();
  return descriptor.value;
}

function denseArray(value) {
  if (!Array.isArray(value)) reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = ownData(descriptors, 'length');
  if (!Number.isSafeInteger(length) || length < 0) reject();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) reject();
    result.push(descriptor.value);
  }
  return result;
}

function stringArray(value, allowed) {
  const result = denseArray(value);
  if (result.length === 0 || !result.every(item => typeof item === 'string' && allowed(item))) reject();
  if (new Set(result).size !== result.length) reject();
  return Object.freeze(result);
}

function snapshotJson(value, state, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject();
    return value;
  }
  if (typeof value !== 'object' || depth > MAX_SNAPSHOT_DEPTH || state.visiting.has(value)) reject();
  state.nodes += 1;
  if (state.nodes > MAX_SNAPSHOT_NODES) reject();
  state.visiting.add(value);

  if (Array.isArray(value)) {
    const result = denseArray(value).map(item => snapshotJson(item, state, depth + 1));
    state.visiting.delete(value);
    return Object.freeze(result);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(descriptors).length > 0) reject();
  const result = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) reject();
    Object.defineProperty(result, key, {
      value: snapshotJson(descriptor.value, state, depth + 1),
      enumerable: true,
      writable: false,
      configurable: false
    });
  }
  state.visiting.delete(value);
  return Object.freeze(result);
}

function validateSchema(schema, depth = 0) {
  if (!schema || Array.isArray(schema) || typeof schema !== 'object' || depth > MAX_SNAPSHOT_DEPTH) reject();
  const type = schema.type;
  const common = new Set(['type', 'enum']);
  if (!['string', 'boolean', 'number', 'integer', 'array', 'object'].includes(type)) reject();
  if (Object.hasOwn(schema, 'enum')) {
    if (type === 'array' || type === 'object') reject();
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) reject();
    for (const item of schema.enum) {
      if (type === 'string' && typeof item !== 'string') reject();
      if (type === 'boolean' && typeof item !== 'boolean') reject();
      if ((type === 'number' || type === 'integer') &&
          (typeof item !== 'number' || !Number.isFinite(item) || (type === 'integer' && !Number.isInteger(item)))) {
        reject();
      }
    }
  }
  if (type === 'string') {
    common.add('minLength');
    common.add('maxLength');
    for (const key of ['minLength', 'maxLength']) {
      if (Object.hasOwn(schema, key) && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)) reject();
    }
    if (schema.minLength > schema.maxLength) reject();
  } else if (type === 'number' || type === 'integer') {
    common.add('minimum');
    common.add('maximum');
    for (const key of ['minimum', 'maximum']) {
      if (Object.hasOwn(schema, key) && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) reject();
    }
    if (schema.minimum > schema.maximum) reject();
  } else if (type === 'array') {
    common.add('items');
    common.add('minItems');
    common.add('maxItems');
    if (!Object.hasOwn(schema, 'items')) reject();
    for (const key of ['minItems', 'maxItems']) {
      if (Object.hasOwn(schema, key) && (!Number.isSafeInteger(schema[key]) || schema[key] < 0 || schema[key] > 100)) {
        reject();
      }
    }
    if (schema.minItems > schema.maxItems) reject();
    validateSchema(schema.items, depth + 1);
  } else if (type === 'object') {
    common.add('properties');
    common.add('required');
    common.add('additionalProperties');
    if (schema.additionalProperties !== false || !schema.properties ||
        Array.isArray(schema.properties) || typeof schema.properties !== 'object') reject();
    const propertyNames = Object.keys(schema.properties);
    if (propertyNames.length > 100) reject();
    for (const property of propertyNames) validateSchema(schema.properties[property], depth + 1);
    if (Object.hasOwn(schema, 'required')) {
      if (!Array.isArray(schema.required) ||
          !schema.required.every(key => typeof key === 'string' && key.length > 0) ||
          new Set(schema.required).size !== schema.required.length ||
          !schema.required.every(key => Object.hasOwn(schema.properties, key))) reject();
    }
  }
  if (Object.keys(schema).some(key => !common.has(key))) reject();
}

function snapshotSchema(value, rootType) {
  const schema = snapshotJson(value, {visiting: new WeakSet(), nodes: 0});
  validateSchema(schema);
  if (rootType && schema.type !== rootType) reject();
  return schema;
}

function snapshotDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) reject();
  const descriptors = Object.getOwnPropertyDescriptors(definition);
  const values = Object.fromEntries(FIELDS.map(field => [field, ownData(descriptors, field)]));
  if (typeof values.name !== 'string' || !NAME.test(values.name)) reject();
  if (values.schemaVersion !== '1') reject();
  if (typeof values.description !== 'string' || values.description.trim().length === 0) reject();
  const executors = stringArray(values.executors, value => EXECUTORS.has(value));
  const scopes = stringArray(values.scopes, value => SCOPE.test(value));
  if (!CONFIRMATIONS.has(values.confirmation) || !MUTATIONS.has(values.mutation)) reject();
  if (typeof values.safeFailover !== 'boolean' || typeof values.implemented !== 'boolean') reject();
  if (values.mutation === 'destructive' && values.confirmation !== 'dangerous') reject();
  if (values.safeFailover && values.mutation !== 'read' && values.mutation !== 'idempotent') reject();
  return Object.freeze({
    name: values.name,
    schemaVersion: values.schemaVersion,
    description: values.description,
    executors,
    scopes,
    confirmation: values.confirmation,
    mutation: values.mutation,
    safeFailover: values.safeFailover,
    implemented: values.implemented,
    inputSchema: snapshotSchema(values.inputSchema, 'object'),
    outputSchema: snapshotSchema(values.outputSchema)
  });
}

function buildRegistry(definitions) {
  const supplied = denseArray(definitions);
  const indexed = new Map();
  for (const suppliedDefinition of supplied) {
    const definition = snapshotDefinition(suppliedDefinition);
    if (indexed.has(definition.name)) reject();
    indexed.set(definition.name, definition);
  }
  const list = Object.freeze([...indexed.values()].sort((a, b) => a.name.localeCompare(b.name)));
  return Object.freeze({
    get(name) { return indexed.get(name) || null; },
    list() { return list; },
    capabilities(health = {}) {
      try {
        if (!health || typeof health !== 'object' || Array.isArray(health)) reject();
        const healthDescriptors = Object.getOwnPropertyDescriptors(health);
        const isOnline = executor => {
          const descriptor = healthDescriptors[executor];
          return Boolean(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value === 'online');
        };
        return Object.freeze(list.map(definition => {
          let availability = 'available';
          if (!definition.implemented) availability = 'not_implemented';
          else if (!definition.executors.includes('core') && !definition.executors.some(isOnline)) {
            availability = definition.executors.includes('gateway') ? 'gateway_offline' : 'extension_offline';
          }
          return Object.freeze({
            name: definition.name,
            schemaVersion: definition.schemaVersion,
            executors: definition.executors,
            scopes: definition.scopes,
            confirmation: definition.confirmation,
            availability
          });
        }));
      } catch {
        reject();
      }
    }
  });
}

export function createRegistry(definitions) {
  try {
    return buildRegistry(definitions);
  } catch {
    reject();
  }
}
