import assert from 'node:assert/strict';
import test from 'node:test';

import {normalizeArgs} from '../src/index.js';

const schema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['chatId', 'limit'],
  properties: {
    chatId: {type: 'string', minLength: 1, maxLength: 128},
    limit: {type: 'integer', minimum: 1, maximum: 100},
    kinds: {
      type: 'array', maxItems: 4,
      items: {type: 'string', enum: ['text', 'photo', 'voice', 'video']}
    }
  }
});

test('normalizes and freezes valid JSON-compatible arguments', () => {
  const result = normalizeArgs({chatId: 'chat-1', limit: 20, kinds: ['text', 'photo']}, schema);
  assert.deepEqual({...result}, {chatId: 'chat-1', limit: 20, kinds: ['text', 'photo']});
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.kinds));
});

test('rejects missing, additional, malformed, and oversized arguments', () => {
  const invalid = [
    {chatId: 'chat-1'},
    {chatId: 'chat-1', limit: 0},
    {chatId: 'chat-1', limit: 20, unknown: true},
    {chatId: 'chat-1', limit: 20, kinds: ['audio']},
    {chatId: 'x'.repeat(129), limit: 20},
    {chatId: 'chat-1', limit: 20, kinds: Array(101).fill('text')},
    {chatId: 'x'.repeat(70 * 1024), limit: 20}
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeArgs(value, schema), {code: 'invalid_input'});
  }
});

test('copies own enumerable data without preserving attacker prototypes', () => {
  const value = Object.create({admin: true});
  value.chatId = 'chat-1';
  value.limit = 20;
  const result = normalizeArgs(value, schema);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal('admin' in result, false);

  const nullPrototypeValue = Object.create(null);
  nullPrototypeValue.chatId = 'chat-2';
  nullPrototypeValue.limit = 10;
  assert.equal(normalizeArgs(nullPrototypeValue, schema).chatId, 'chat-2');
});

test('rejects accessors and wraps hostile reflection without leaking secrets', () => {
  const secret = 'fixture-hostile-input-secret-must-not-escape';
  let getterCalls = 0;
  const getterValue = {limit: 20};
  Object.defineProperty(getterValue, 'chatId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(secret);
    }
  });

  const toJSONValue = {chatId: 'chat-1', limit: 20};
  Object.defineProperty(toJSONValue, 'toJSON', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(secret);
    }
  });

  const proxyValue = new Proxy({}, {
    ownKeys() {
      throw new Error(secret);
    }
  });

  for (const value of [getterValue, toJSONValue, proxyValue]) {
    assert.throws(() => normalizeArgs(value, schema), error => {
      assert.equal(error.code, 'invalid_input');
      assert.equal(String(error).includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    });
  }
  assert.equal(getterCalls, 0);
});

test('sizes the normalized output in UTF-8 without consulting toJSON', () => {
  const stringSchema = {type: 'string'};
  assert.equal(normalizeArgs('é'.repeat(32_767), stringSchema).length, 32_767);
  assert.throws(() => normalizeArgs('é'.repeat(32_768), stringSchema), {code: 'invalid_input'});

  const value = {chatId: 'x'.repeat(70 * 1024), limit: 20};
  Object.defineProperty(value, 'toJSON', {value: () => ({chatId: 'x', limit: 20})});
  const wideSchema = {
    type: 'object',
    required: ['chatId', 'limit'],
    properties: {chatId: {type: 'string'}, limit: {type: 'integer'}}
  };
  assert.throws(() => normalizeArgs(value, wideSchema), {code: 'invalid_input'});
});

test('rejects sparse arrays and inherited indices while returning dense ordinary arrays', () => {
  const arraySchema = {type: 'array', items: {type: 'string'}};
  const sparse = Array(2);
  sparse[1] = 'text';
  assert.throws(() => normalizeArgs(sparse, arraySchema), {code: 'invalid_input'});

  const inheritedIndex = Array(1);
  Object.setPrototypeOf(inheritedIndex, {0: 'text'});
  assert.throws(() => normalizeArgs(inheritedIndex, arraySchema), {code: 'invalid_input'});

  let accessorCalls = 0;
  const accessorElement = Array(1);
  Object.defineProperty(accessorElement, 0, {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return 'text';
    }
  });
  assert.throws(() => normalizeArgs(accessorElement, arraySchema), {code: 'invalid_input'});
  assert.equal(accessorCalls, 0);

  const customPrototype = ['text'];
  Object.setPrototypeOf(customPrototype, {attacker: true});
  const result = normalizeArgs(customPrototype, arraySchema);
  assert.equal(Object.getPrototypeOf(result), Array.prototype);
  assert.deepEqual(result, ['text']);
  assert(Object.isFrozen(result));
});

test('enforces depth and object-key limits', () => {
  function nested(depth) {
    let nestedSchema = {type: 'string'};
    let value = 'leaf';
    for (let index = 0; index < depth; index += 1) {
      nestedSchema = {type: 'object', required: ['child'], properties: {child: nestedSchema}};
      value = {child: value};
    }
    return {nestedSchema, value};
  }

  const atDepthLimit = nested(8);
  assert.equal(normalizeArgs(atDepthLimit.value, atDepthLimit.nestedSchema).child.child.child.child.child.child.child.child, 'leaf');
  const overDepthLimit = nested(9);
  assert.throws(() => normalizeArgs(overDepthLimit.value, overDepthLimit.nestedSchema), {code: 'invalid_input'});

  const keySchema = {type: 'object', additionalProperties: {type: 'boolean'}};
  const atKeyLimit = Object.fromEntries(Array.from({length: 100}, (_, index) => [`key${index}`, true]));
  assert.equal(Object.keys(normalizeArgs(atKeyLimit, keySchema)).length, 100);
  assert.throws(
    () => normalizeArgs({...atKeyLimit, overflow: true}, keySchema),
    {code: 'invalid_input'}
  );
});

test('removes hostile prototypes throughout nested object data', () => {
  const nestedSchema = {
    type: 'object',
    required: ['details'],
    properties: {
      details: {type: 'object', required: ['enabled'], properties: {enabled: {type: 'boolean'}}}
    }
  };
  const details = Object.create({admin: true});
  details.enabled = true;
  const result = normalizeArgs({details}, nestedSchema);
  assert.equal(Object.getPrototypeOf(result.details), null);
  assert.equal('admin' in result.details, false);
  assert.equal(result.details.enabled, true);
});

test('validates numbers, booleans, minItems, finite values, and integer items', () => {
  const scalarSchema = {
    type: 'object',
    required: ['amount', 'enabled', 'ids'],
    properties: {
      amount: {type: 'number', minimum: 0, maximum: 10},
      enabled: {type: 'boolean'},
      ids: {type: 'array', minItems: 1, items: {type: 'integer'}}
    }
  };
  const result = normalizeArgs({amount: 2.5, enabled: true, ids: [1]}, scalarSchema);
  assert.equal(result.amount, 2.5);

  const invalid = [
    {amount: Number.NaN, enabled: true, ids: [1]},
    {amount: Number.POSITIVE_INFINITY, enabled: true, ids: [1]},
    {amount: 2.5, enabled: 'yes', ids: [1]},
    {amount: 2.5, enabled: true, ids: []},
    {amount: 2.5, enabled: true, ids: [1.5]}
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeArgs(value, scalarSchema), {code: 'invalid_input'});
  }
});
