import assert from 'node:assert/strict';
import test from 'node:test';

import {CORE_TOOL_DEFINITIONS, createToolCore, toolError} from '../src/index.js';

const EMPTY_OUTPUT = Object.freeze({type: 'object', properties: {}, additionalProperties: false});
const PROFILE_OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['operation', 'userId'],
  properties: {operation: {type: 'string'}, userId: {type: 'string'}}
});
const NESTED_MESSAGE_OUTPUT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {items: {
    type: 'array',
    items: {
      type: 'object', additionalProperties: false, required: ['message'],
      properties: {message: {type: 'string'}}
    }
  }}
});
const MESSAGE_OUTPUT = Object.freeze({
  type: 'object', additionalProperties: false, required: ['message'],
  properties: {message: {type: 'string'}}
});
const FIXED_REQUEST_IDS = [1, 2, 3, 4, 5].map(number =>
  `req_00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
);

function definitionsWithOutput(name, outputSchema = EMPTY_OUTPUT) {
  return CORE_TOOL_DEFINITIONS.map(item => item.name === name
    ? {...item, implemented: true, outputSchema}
    : item);
}

const definitionsWith = (...implementedNames) => CORE_TOOL_DEFINITIONS.map(item =>
  implementedNames.includes(item.name) ? {...item, implemented: true, outputSchema: EMPTY_OUTPUT} : item
);
const flushAudit = () => new Promise(resolve => setTimeout(resolve, 5));

test('runs validation and authorization before the executor', async () => {
  let calls = 0;
  const core = createToolCore({
    definitions: definitionsWithOutput('pure.discovery.profile.get', PROFILE_OUTPUT),
    requestId: () => FIXED_REQUEST_IDS[0],
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
  const core = createToolCore({definitions: CORE_TOOL_DEFINITIONS, requestId: () => FIXED_REQUEST_IDS[1]});
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
    requestId: () => FIXED_REQUEST_IDS[2],
    audit: event => events.push(event),
    executors: {gateway: {
      async health() { return 'online'; },
      async execute() { throw new Error(secret); }
    }}
  });
  const result = await core.invoke('pure.discovery.profile.get', {userId: 'private-user-id'}, {
    callerId: 'private-agent-id', accountId: 'private-account-id', scopes: ['pure:read'], callerType: 'mcp'
  });
  await flushAudit();
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
    requestId: () => FIXED_REQUEST_IDS[3],
    audit: event => events.push(event)
  });

  const result = await core.invoke(secret, {}, context);
  await flushAudit();

  assert.equal(result.error, 'operation_not_found');
  assert.equal(events[0].tool, 'invalid');
  assert.equal(events[0].callerType, 'system');
  assert(!JSON.stringify(events).includes(secret));
});

test('ignores asynchronous audit rejection', async () => {
  const core = createToolCore({
    definitions: CORE_TOOL_DEFINITIONS,
    requestId: () => FIXED_REQUEST_IDS[4],
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
  await flushAudit();
  assert.match(result.requestId, /^req_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(events[0].requestId, result.requestId);
});

test('snapshots and deeply freezes executor output', async () => {
  const supplied = {items: [{message: 'ordinary secret planning text'}]};
  const core = createToolCore({
    definitions: definitionsWithOutput('pure.discovery.profile.get', NESTED_MESSAGE_OUTPUT),
    executors: {gateway: {
      async health() { return 'online'; },
      async execute() { return supplied; }
    }}
  });
  const result = await core.invoke('pure.discovery.profile.get', {userId: 'user-1'}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
  });

  supplied.items[0].message = 'mutated';
  supplied.items.push({message: 'late'});
  assert.equal(result.ok, true);
  assert.deepEqual({...result.data}, {items: result.data.items});
  assert.deepEqual({...result.data.items[0]}, {message: 'ordinary secret planning text'});
  assert(Object.isFrozen(result.data));
  assert(Object.isFrozen(result.data.items));
  assert(Object.isFrozen(result.data.items[0]));
});

test('rejects accessor, hostile proxy, cyclic, and oversized executor output canonically', async () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() { getterCalls += 1; return 'fixture-accessor-secret'; }
  });
  const hostile = new Proxy({}, {ownKeys() { throw new Error('fixture-proxy-secret'); }});
  const cyclic = {};
  cyclic.self = cyclic;
  const oversized = {text: '😀'.repeat(20_000)};
  const tooManyItems = new Array(101).fill(null);
  const tooManyKeys = Object.fromEntries(Array.from({length: 101}, (_, index) => [`key${index}`, null]));
  let tooDeep = null;
  for (let index = 0; index < 10; index += 1) tooDeep = {next: tooDeep};
  let toJSONCalls = 0;
  const withToJSON = {
    message: 'safe',
    toJSON() { toJSONCalls += 1; return {authorization: 'fixture-to-json-secret'}; }
  };

  for (const [output, code] of [
    [accessor, 'executor_rejected'],
    [hostile, 'executor_rejected'],
    [cyclic, 'executor_rejected'],
    [tooManyItems, 'executor_rejected'],
    [tooManyKeys, 'executor_rejected'],
    [tooDeep, 'executor_rejected'],
    [withToJSON, 'executor_rejected'],
    [oversized, 'result_too_large']
  ]) {
    const core = createToolCore({
      definitions: definitionsWith('pure.discovery.profile.get'),
      executors: {gateway: {
        async health() { return 'online'; },
        async execute() { return output; }
      }}
    });
    const result = await core.invoke('pure.discovery.profile.get', {userId: 'user-1'}, {
      callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
    });
    assert.equal(result.error, code);
    assert(!JSON.stringify(result).includes('fixture-'));
  }
  assert.equal(getterCalls, 0);
  assert.equal(toJSONCalls, 0);
});

test('rejects credential-bearing executor output without rejecting ordinary message text', async () => {
  const allowedCore = createToolCore({
    definitions: definitionsWithOutput('pure.discovery.profile.get', MESSAGE_OUTPUT),
    executors: {gateway: {
      async health() { return 'online'; },
      async execute() { return {message: 'ordinary secret planning text'}; }
    }}
  });
  const allowed = await allowedCore.invoke('pure.discovery.profile.get', {userId: 'user-1'}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.data.message, 'ordinary secret planning text');

  const forbidden = [
    {message: 'safe', token: 'skliveABC123'},
    {message: 'safe', documentCookie: 'fixture-cookie'},
    {message: 'safe', protectedUrl: 'https://private-cdn.thepure.app/photo'},
    {message: 'safe', unexpected: true},
    {message: 'Bearer abc.def.ghi'}
  ];
  for (const output of forbidden) {
    const core = createToolCore({
      definitions: definitionsWithOutput('pure.discovery.profile.get', MESSAGE_OUTPUT),
      executors: {gateway: {
        async health() { return 'online'; },
        async execute() { return output; }
      }}
    });
    const result = await core.invoke('pure.discovery.profile.get', {userId: 'user-1'}, {
      callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
    });
    assert.equal(result.error, 'executor_rejected');
    assert(!JSON.stringify(result).includes('abc.def.ghi'));
    assert(!JSON.stringify(result).includes('private-cdn'));
  }
});

test('falls back for unsafe request IDs in public results and audit', async () => {
  for (const unsafe of [
    ' has-space ', 'line\nbreak', 'fixture-request-id-secret', 'skliveABC123',
    'req_skliveABC123', {}, Promise.resolve('late')
  ]) {
    const events = [];
    const core = createToolCore({
      definitions: CORE_TOOL_DEFINITIONS,
      requestId: () => unsafe,
      audit: event => events.push(event)
    });
    const result = await core.invoke('system.capabilities.list', {}, {
      callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
    });
    await flushAudit();
    assert.match(result.requestId, /^req_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(result.requestId, unsafe);
    assert.equal(events[0].requestId, result.requestId);
    assert(!JSON.stringify({result, events}).includes('fixture-request-id-secret'));
  }
});

test('snapshots hostile and malformed core options without invoking getters', async () => {
  let getterCalls = 0;
  const optionalAccessors = {definitions: CORE_TOOL_DEFINITIONS};
  for (const key of ['audit', 'requestId', 'confirmationVerifier', 'executors']) {
    Object.defineProperty(optionalAccessors, key, {
      enumerable: true,
      get() { getterCalls += 1; throw new Error('fixture-options-secret'); }
    });
  }
  const accessorCore = createToolCore(optionalAccessors);
  const allowed = await accessorCore.invoke('system.capabilities.list', {}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
  });
  assert.equal(allowed.ok, true);
  assert.equal(getterCalls, 0);

  const malformedOptionalCore = createToolCore({
    definitions: CORE_TOOL_DEFINITIONS,
    audit: 'not-a-function',
    requestId: {},
    confirmationVerifier: 42,
    executors: 'not-an-executor-map'
  });
  const malformedAllowed = await malformedOptionalCore.invoke('system.capabilities.list', {}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
  });
  assert.equal(malformedAllowed.ok, true);

  const hostile = new Proxy({}, {ownKeys() { throw new Error('fixture-proxy-options-secret'); }});
  for (const core of [createToolCore(null), createToolCore(hostile)]) {
    const result = await core.invoke('fixture-options-secret', {}, {});
    assert.equal(result.error, 'operation_not_found');
    assert(!JSON.stringify(result).includes('fixture-options-secret'));
  }
});

test('does not wait for a never-settling audit callback', async () => {
  let settled = false;
  let auditBegan = false;
  const core = createToolCore({
    definitions: CORE_TOOL_DEFINITIONS,
    audit: () => {
      auditBegan = true;
      return new Promise(() => {});
    }
  });
  const invocation = core.invoke('system.capabilities.list', {}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
  }).then(result => { settled = true; return result; });

  const result = await Promise.race([
    invocation,
    new Promise((_, reject) => setTimeout(() => reject(new Error('invoke blocked on audit')), 50))
  ]);
  assert.equal(settled, true);
  assert.equal(result.ok, true);
  assert.equal(auditBegan, false);
  await flushAudit();
  assert.equal(auditBegan, true);
});

test('resolves invoke before a slow synchronous audit callback begins', async () => {
  let began = false;
  let finished = false;
  const core = createToolCore({
    definitions: CORE_TOOL_DEFINITIONS,
    audit: () => {
      began = true;
      const until = Date.now() + 80;
      while (Date.now() < until) {}
      finished = true;
      return Object.defineProperty({}, 'then', {
        get() { throw new Error('fixture-hostile-thenable-secret'); }
      });
    }
  });

  const result = await core.invoke('system.capabilities.list', {}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
  });
  assert.equal(result.ok, true);
  assert.equal(began, false);
  assert.equal(finished, false);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(began, true);
  assert.equal(finished, true);
});

test('attributes canonical and raw executor failures to the attempted executor', async () => {
  for (const failureValue of [toolError('provider_rejected'), new Error('fixture-provider-secret')]) {
    const events = [];
    const core = createToolCore({
      definitions: definitionsWith('pure.discovery.profile.get'),
      audit: event => events.push(event),
      executors: {gateway: {
        async health() { return 'online'; },
        async execute() { throw failureValue; }
      }}
    });
    const result = await core.invoke('pure.discovery.profile.get', {userId: 'user-1'}, {
      callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
    });
    await flushAudit();
    assert.equal(result.executor, 'gateway');
    assert.equal(events[0].executor, 'gateway');
    assert(!JSON.stringify({result, events}).includes('fixture-provider-secret'));
  }
});

test('attributes executor health failure to the selected executor', async () => {
  const events = [];
  const core = createToolCore({
    definitions: definitionsWith('pure.discovery.profile.get'),
    audit: event => events.push(event),
    executors: {gateway: {
      async health() { return 'offline'; },
      async execute() { throw new Error('must not run'); }
    }}
  });
  const result = await core.invoke('pure.discovery.profile.get', {userId: 'user-1'}, {
    callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']
  });
  await flushAudit();
  assert.equal(result.error, 'gateway_offline');
  assert.equal(result.executor, 'gateway');
  assert.equal(events[0].executor, 'gateway');
});
