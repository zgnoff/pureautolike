import {toolError} from './errors.js';

export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_DEPTH = 8;
export const MAX_KEYS = 100;
export const MAX_ITEMS = 100;

function invalid() {
  throw toolError('invalid_input');
}

function checkNumber(value, schema, integer) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) invalid();
  if (typeof schema.minimum === 'number' && value < schema.minimum) invalid();
  if (typeof schema.maximum === 'number' && value > schema.maximum) invalid();
  return value;
}

function isDataDescriptor(descriptor) {
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value');
}

function copy(value, schema, depth) {
  if (depth > MAX_DEPTH || !schema || typeof schema !== 'object') invalid();
  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) invalid();
  if (schema.type === 'string') {
    if (typeof value !== 'string') invalid();
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) invalid();
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) invalid();
    return value;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') invalid();
    return value;
  }
  if (schema.type === 'number') return checkNumber(value, schema, false);
  if (schema.type === 'integer') return checkNumber(value, schema, true);
  if (schema.type === 'array') {
    if (!Array.isArray(value)) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    if (!isDataDescriptor(lengthDescriptor)) invalid();
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ITEMS) invalid();
    if (Number.isInteger(schema.minItems) && length < schema.minItems) invalid();
    if (Number.isInteger(schema.maxItems) && length > schema.maxItems) invalid();
    const output = new Array(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor?.enumerable || !isDataDescriptor(descriptor)) invalid();
      output[index] = copy(descriptor.value, schema.items, depth + 1);
    }
    return Object.freeze(output);
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors).filter(key => (
      typeof key === 'string' && descriptors[key].enumerable
    ));
    if (keys.length > MAX_KEYS) invalid();
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      const descriptor = descriptors[required];
      if (!descriptor?.enumerable || !isDataDescriptor(descriptor)) invalid();
    }
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!isDataDescriptor(descriptor)) invalid();
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        if (schema.additionalProperties === false) invalid();
        output[key] = copy(descriptor.value, schema.additionalProperties, depth + 1);
      } else {
        output[key] = copy(descriptor.value, properties[key], depth + 1);
      }
    }
    return Object.freeze(output);
  }
  invalid();
}

export function normalizeArgs(value, schema) {
  try {
    const output = copy(value, schema, 0);
    const serialized = JSON.stringify(output);
    if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > MAX_INPUT_BYTES) invalid();
    return output;
  } catch (_) {
    invalid();
  }
}
