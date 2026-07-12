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
});
