import assert from 'node:assert/strict';
import test from 'node:test';

import {CORE_TOOL_DEFINITIONS, createRegistry} from '../src/index.js';

const EXPECTED_NAMES = [
  'system.capabilities.list',
  'system.operation.get',
  'system.workflow.get',
  'system.workflow.cancel',
  'system.confirmation.resolve',
  'pure.session.status',
  'pure.session.activate',
  'pure.session.rotate',
  'pure.session.reconnect',
  'pure.session.revoke',
  'pure.session.delete',
  'pure.discovery.state.get',
  'pure.discovery.preferences.get',
  'pure.discovery.profile.next',
  'pure.discovery.profile.get',
  'pure.discovery.reaction.like',
  'pure.discovery.reaction.skip',
  'pure.discovery.workflow.start',
  'pure.discovery.workflow.pause',
  'pure.discovery.workflow.resume',
  'pure.discovery.workflow.stop',
  'pure.discovery.workflow.status',
  'pure.matches.list',
  'pure.matches.get',
  'pure.matches.block',
  'pure.matches.report',
  'pure.matches.unmatch',
  'pure.matches.remove',
  'pure.chats.list',
  'pure.chats.get',
  'pure.chats.history.list',
  'pure.chats.events.list',
  'pure.chats.message.send',
  'pure.chats.read.mark',
  'pure.chats.delete',
  'pure.chats.clear',
  'pure.media.profile_photos.list',
  'pure.media.photo.get',
  'pure.media.download',
  'pure.media.upload',
  'pure.media.transfer.status',
  'pure.profile.get',
  'pure.profile.update',
  'pure.profile.photos.upload',
  'pure.profile.photos.reorder',
  'pure.profile.photos.delete',
  'pure.profile.location.get',
  'pure.profile.location.update',
  'pure.profile.visibility.update',
  'extension.autolike.status',
  'extension.autolike.config.get',
  'extension.autolike.config.update',
  'extension.autolike.start',
  'extension.autolike.pause',
  'extension.autolike.resume',
  'extension.autolike.stop',
  'extension.autolike.stats',
  'extension.telegram.status',
  'extension.telegram.connect',
  'extension.telegram.test',
  'extension.telegram.pause',
  'extension.telegram.resume',
  'extension.telegram.disconnect',
  'extension.browser.status',
  'extension.browser.tab.open',
  'extension.browser.tab.focus',
  'extension.browser.operation.request'
];

const EMPTY_INPUT = {type: 'object', properties: {}, additionalProperties: false};

function definition(name, options = {}) {
  return {
    name,
    schemaVersion: '1',
    description: name,
    executors: ['gateway'],
    scopes: ['pure:read'],
    confirmation: 'none',
    mutation: 'read',
    safeFailover: true,
    implemented: true,
    inputSchema: EMPTY_INPUT,
    ...options
  };
}

test('registers every version-1 tool with explicit safety metadata', () => {
  const registry = createRegistry(CORE_TOOL_DEFINITIONS);
  const list = registry.list();
  assert.equal(list.length, 67);
  assert.deepEqual(list.map(item => item.name), EXPECTED_NAMES.toSorted());
  for (const item of list) {
    assert.equal(item.schemaVersion, '1');
    assert(item.executors.length > 0);
    assert(Array.isArray(item.scopes));
    if (item.mutation === 'destructive') assert.equal(item.confirmation, 'dangerous');
  }
});

test('deep-freezes canonical schemas', () => {
  const profile = CORE_TOOL_DEFINITIONS.find(item => item.name === 'pure.discovery.profile.get');
  const matches = CORE_TOOL_DEFINITIONS.find(item => item.name === 'pure.matches.list');
  assert(Object.isFrozen(profile.inputSchema));
  assert(Object.isFrozen(profile.inputSchema.required));
  assert(Object.isFrozen(profile.inputSchema.properties));
  assert(Object.isFrozen(profile.inputSchema.properties.userId));
  assert(Object.isFrozen(matches.inputSchema.properties.limit));
  assert.throws(() => profile.inputSchema.required.push('admin'), {name: 'TypeError'});
  assert.throws(() => { profile.inputSchema.properties.userId.maxLength = 10_000; }, {name: 'TypeError'});
});

test('marks unavailable catalog operations honestly', () => {
  const registry = createRegistry(CORE_TOOL_DEFINITIONS);
  const capabilities = registry.capabilities({gateway: 'online', extension: 'offline'});
  const photoList = capabilities.find(item => item.name === 'pure.media.profile_photos.list');
  const autolike = capabilities.find(item => item.name === 'extension.autolike.start');
  assert.equal(photoList.availability, 'not_implemented');
  assert.equal(autolike.availability, 'not_implemented');
  assert.equal(Object.isFrozen(capabilities), true);
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

test('snapshots caller definitions and nested schema data', () => {
  const original = definition('pure.test.snapshot', {
    executors: ['gateway'],
    scopes: ['pure:read'],
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {kind: {type: 'string', enum: ['photo']}}
    }
  });
  const registry = createRegistry([original]);
  const snapshot = registry.get(original.name);

  original.description = 'changed';
  original.executors.push('extension');
  original.scopes.push('pure:account:dangerous');
  original.inputSchema.required.push('admin');
  original.inputSchema.properties.kind.enum.push('secret');
  original.inputSchema.properties.admin = {type: 'boolean'};

  assert.notEqual(snapshot, original);
  assert.equal(snapshot.description, 'pure.test.snapshot');
  assert.deepEqual(snapshot.executors, ['gateway']);
  assert.deepEqual(snapshot.scopes, ['pure:read']);
  assert.deepEqual(snapshot.inputSchema.required, ['kind']);
  assert.deepEqual(snapshot.inputSchema.properties.kind.enum, ['photo']);
  assert.equal(snapshot.inputSchema.properties.admin, undefined);
  assert(Object.isFrozen(snapshot));
  assert(Object.isFrozen(snapshot.inputSchema.properties.kind.enum));
  assert.equal(registry.list()[0], snapshot);
  const firstCapability = registry.capabilities({gateway: 'online'})[0];
  const secondCapability = registry.capabilities({gateway: 'online'})[0];
  assert(Object.isFrozen(firstCapability));
  assert.notEqual(firstCapability, secondCapability);
  assert.deepEqual(firstCapability.executors, ['gateway']);
  assert.throws(() => snapshot.executors.push('extension'), {name: 'TypeError'});
});

test('rejects incomplete and malformed explicit metadata', () => {
  const base = definition('pure.test.metadata');
  const missingDescription = {...base};
  delete missingDescription.description;
  const invalid = [
    missingDescription,
    {...base, description: ''},
    {...base, implemented: 1},
    {...base, safeFailover: 'yes'},
    {...base, scopes: []},
    {...base, scopes: ['']},
    {...base, inputSchema: {type: 'string'}},
    {...base, inputSchema: {type: 'object', properties: [], additionalProperties: false}},
    {...base, inputSchema: {type: 'object', properties: {}, additionalProperties: true}},
    {...base, inputSchema: {type: 'object', properties: {}, additionalProperties: false, required: 'id'}}
  ];
  for (const value of invalid) assert.throws(() => createRegistry([value]), {code: 'invalid_input'});
});

test('wraps hostile definition reflection as invalid input without leaking errors', () => {
  const secret = 'fixture-registry-secret-must-not-escape';
  const accessor = definition('pure.test.accessor');
  Object.defineProperty(accessor, 'description', {
    enumerable: true,
    get() { throw new Error(secret); }
  });
  const proxy = new Proxy(definition('pure.test.proxy'), {
    ownKeys() { throw new Error(secret); }
  });
  for (const value of [accessor, proxy]) {
    assert.throws(() => createRegistry([value]), error => {
      assert.equal(error.code, 'invalid_input');
      assert.equal(String(error).includes(secret), false);
      return true;
    });
  }
});

test('reports live core, gateway, extension, and mixed availability', () => {
  const registry = createRegistry([
    definition('system.test.core', {executors: ['core']}),
    definition('pure.test.gateway', {executors: ['gateway']}),
    definition('extension.test.only', {executors: ['extension'], scopes: ['extension:control']}),
    definition('pure.test.mixed', {executors: ['gateway', 'extension']})
  ]);
  const availability = health => Object.fromEntries(
    registry.capabilities(health).map(item => [item.name, item.availability])
  );

  assert.deepEqual(availability({}), {
    'extension.test.only': 'extension_offline',
    'pure.test.gateway': 'gateway_offline',
    'pure.test.mixed': 'gateway_offline',
    'system.test.core': 'available'
  });
  assert.equal(availability({gateway: 'online'})['pure.test.mixed'], 'available');
  assert.equal(availability({extension: 'online'})['pure.test.mixed'], 'available');
  assert.equal(availability({extension: 'online'})['pure.test.gateway'], 'gateway_offline');
  assert.equal(availability({gateway: 'online'})['extension.test.only'], 'extension_offline');
});
