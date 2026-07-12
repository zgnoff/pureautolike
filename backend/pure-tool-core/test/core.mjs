import assert from 'node:assert/strict';
import test from 'node:test';

import {CORE_TOOL_DEFINITIONS, createToolCore} from '../src/index.js';

function definitionsWith(...implementedNames) {
  const names = new Set(implementedNames);
  return CORE_TOOL_DEFINITIONS.map(item => names.has(item.name) ? {...item, implemented: true} : item);
}

test('runs validation and authorization before the executor', async () => {
  let calls = 0;
  const core = createToolCore({
    definitions: definitionsWith('pure.discovery.profile.get'),
    requestId: () => 'req-1',
    executors: {gateway: {
      async health() { return 'online'; },
      async execute(operation, args) { calls += 1; return {operation, userId: args.userId}; }
    }}
  });
  const denied = await core.invoke('pure.discovery.profile.get', {userId: 'user-1'}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: []
  });
  assert.equal(denied.error, 'permission_denied');
  assert.equal(calls, 0);

  const allowed = await core.invoke('pure.discovery.profile.get', {userId: 'user-1'}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.executor, 'gateway');
  assert.equal(calls, 1);
});

test('returns honest capability and not-implemented results', async () => {
  const core = createToolCore({definitions: CORE_TOOL_DEFINITIONS, requestId: () => 'req-2'});
  const capabilities = await core.invoke('system.capabilities.list', {}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
  });
  assert(capabilities.ok);
  assert(capabilities.data.some(item => item.name === 'extension.autolike.start'));

  const unavailable = await core.invoke('extension.autolike.start', {}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: ['extension:control']
  });
  assert.equal(unavailable.error, 'capability_not_implemented');
});

test('audits metadata without arguments, results, identifiers, or secrets', async () => {
  const events = [];
  const secret = 'fixture-end-to-end-secret';
  const core = createToolCore({
    definitions: definitionsWith('pure.discovery.profile.get'),
    requestId: () => 'req-3',
    audit: event => events.push(event),
    executors: {gateway: {
      async health() { return 'online'; },
      async execute() { throw new Error(secret); }
    }}
  });
  const result = await core.invoke('pure.discovery.profile.get', {userId: 'private-user-id'}, {
    callerId: 'private-agent-id', accountId: 'private-account-id', scopes: ['pure:read'], callerType: 'mcp'
  });
  assert.equal(result.error, 'executor_rejected');
  const serialized = JSON.stringify({result, events});
  assert(!serialized.includes(secret));
  assert(!serialized.includes('private-user-id'));
  assert(!serialized.includes('private-agent-id'));
  assert(!serialized.includes('private-account-id'));
  assert.deepEqual(Object.keys(events[0]).sort(), [
    'callerType', 'confirmation', 'durationMs', 'executor',
    'requestId', 'resultCode', 'schemaVersion', 'tool'
  ]);
});

test('redacts invalid operation names and hostile caller metadata from audit', async () => {
  const events = [];
  const secret = 'fixture-invalid-operation-secret';
  const context = {
    callerId: 'agent-1',
    accountId: 'account-1',
    scopes: ['pure:read']
  };
  Object.defineProperty(context, 'callerType', {
    enumerable: true,
    get() { throw new Error('fixture-caller-type-secret'); }
  });
  const core = createToolCore({
    definitions: CORE_TOOL_DEFINITIONS,
    requestId: () => 'req-4',
    audit: event => events.push(event)
  });

  const result = await core.invoke(secret, {}, context);

  assert.equal(result.error, 'operation_not_found');
  assert.equal(events[0].tool, 'invalid');
  assert.equal(events[0].callerType, 'system');
  assert(!JSON.stringify(events).includes(secret));
});

test('ignores asynchronous audit rejection', async () => {
  const core = createToolCore({
    definitions: CORE_TOOL_DEFINITIONS,
    requestId: () => 'req-5',
    audit: async () => { throw new Error('fixture-audit-secret'); }
  });

  const result = await core.invoke('system.capabilities.list', {}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
  });

  assert.equal(result.ok, true);
});

test('uses a safe fallback when request ID generation fails', async () => {
  const events = [];
  const core = createToolCore({
    definitions: CORE_TOOL_DEFINITIONS,
    requestId: () => { throw new Error('fixture-request-id-secret'); },
    audit: event => events.push(event)
  });

  const result = await core.invoke('system.capabilities.list', {}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
  });

  assert.equal(result.ok, true);
  assert.match(result.requestId, /^req_[0-9a-f-]+$/);
  assert.equal(events[0].requestId, result.requestId);
});
