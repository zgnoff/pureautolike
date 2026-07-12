import assert from 'node:assert/strict';
import test from 'node:test';

import {CORE_TOOL_DEFINITIONS, createRegistry} from '../src/index.js';

const REQUIRED_PREFIXES = [
  'pure.discovery.', 'pure.matches.', 'pure.chats.', 'pure.media.',
  'pure.profile.', 'pure.session.', 'extension.autolike.',
  'extension.telegram.', 'extension.browser.', 'system.'
];

test('registers every version-1 tool with explicit safety metadata', () => {
  const registry = createRegistry(CORE_TOOL_DEFINITIONS);
  const list = registry.list();
  assert(list.length >= 55);
  assert.equal(new Set(list.map(item => item.name)).size, list.length);
  for (const prefix of REQUIRED_PREFIXES) {
    assert(list.some(item => item.name.startsWith(prefix)), `missing ${prefix}`);
  }
  for (const item of list) {
    assert.equal(item.schemaVersion, '1');
    assert(item.executors.length > 0);
    assert(Array.isArray(item.scopes));
    if (item.mutation === 'destructive') assert.equal(item.confirmation, 'dangerous');
  }
});

test('marks unavailable catalog operations honestly', () => {
  const registry = createRegistry(CORE_TOOL_DEFINITIONS);
  const capabilities = registry.capabilities({gateway: 'online', extension: 'offline'});
  const photoList = capabilities.find(item => item.name === 'pure.media.profile_photos.list');
  const autolike = capabilities.find(item => item.name === 'extension.autolike.start');
  assert.equal(photoList.availability, 'not_implemented');
  assert.equal(autolike.availability, 'not_implemented');
});

test('rejects duplicate, malformed, and unsafe definitions', () => {
  const base = CORE_TOOL_DEFINITIONS[0];
  assert.throws(() => createRegistry([base, base]), {code: 'invalid_input'});
  assert.throws(() => createRegistry([{...base, name: 'Bad Name'}]), {code: 'invalid_input'});
  assert.throws(
    () => createRegistry([{...base, name: 'pure.profile.delete', mutation: 'destructive', confirmation: 'none'}]),
    {code: 'invalid_input'}
  );
});

test('rejects missing schemas, unknown executors, and unsafe failover', () => {
  const base = CORE_TOOL_DEFINITIONS[0];
  assert.throws(() => createRegistry([{...base, inputSchema: null}]), {code: 'invalid_input'});
  assert.throws(() => createRegistry([{...base, executors: ['browser']}]), {code: 'invalid_input'});
  assert.throws(
    () => createRegistry([{...base, mutation: 'non_idempotent', safeFailover: true}]),
    {code: 'invalid_input'}
  );
});
