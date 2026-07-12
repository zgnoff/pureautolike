import assert from 'node:assert/strict';
import test from 'node:test';

import {createRegistry, createRouter, CORE_TOOL_DEFINITIONS, ToolCoreError, toolError} from '../src/index.js';

const registry = createRegistry(CORE_TOOL_DEFINITIONS);
const executor = (name, state = 'online', behavior = async operation => ({name, operation})) => ({
  async health() { return state; },
  execute: behavior
});

test('prefers the gateway for operations supported by both executors', async () => {
  const router = createRouter({executors: {
    gateway: executor('gateway'), extension: executor('extension')
  }});
  const definition = {...registry.get('pure.chats.list'), implemented: true, executors: ['gateway', 'extension']};
  const result = await router.execute(definition, {}, {});
  assert.equal(result.executor, 'gateway');
});

test('uses extension for extension-only operations and reports offline state', async () => {
  const online = createRouter({executors: {extension: executor('extension')}});
  const definition = {...registry.get('extension.autolike.start'), implemented: true};
  assert.equal((await online.execute(definition, {}, {})).executor, 'extension');

  const offline = createRouter({executors: {extension: executor('extension', 'offline')}});
  await assert.rejects(offline.execute(definition, {}, {}), {code: 'extension_offline'});
});

test('fails over only for safe reads with a definitive offline error', async () => {
  const router = createRouter({executors: {
    gateway: executor('gateway', 'online', async () => { throw toolError('gateway_offline', {retryable: true}); }),
    extension: executor('extension')
  }});
  const safe = {...registry.get('pure.chats.list'), implemented: true, executors: ['gateway', 'extension']};
  assert.equal((await router.execute(safe, {}, {})).executor, 'extension');

  const mutation = {...registry.get('pure.discovery.reaction.like'), implemented: true, executors: ['gateway', 'extension']};
  await assert.rejects(router.execute(mutation, {userId: 'user-1'}, {}), {code: 'gateway_offline'});
});

test('does not send arbitrary operation data to an unregistered executor', async () => {
  const router = createRouter({executors: {unknown: executor('unknown')}});
  const definition = {...registry.get('pure.chats.list'), implemented: true};
  await assert.rejects(router.execute(definition, {}, {}), {code: 'gateway_offline'});
});

test('normalizes health to frozen owned enum values without retaining executor output', async () => {
  const secret = {state: 'online', secret: 'do-not-retain'};
  const router = createRouter({executors: {
    gateway: executor('gateway', secret),
    extension: executor('extension', 'reauth_required')
  }});
  const health = await router.health();
  assert.deepEqual(health, {gateway: 'offline', extension: 'reauth_required'});
  assert.equal(Object.isFrozen(health), true);
  assert.equal(Object.getPrototypeOf(health), Object.prototype);
  assert.equal(health.gateway === secret, false);

  const throwing = createRouter({executors: {
    gateway: executor('gateway', 'online', async () => null),
    extension: {async health() { throw new Error('secret'); }, async execute() {}}
  }});
  assert.deepEqual(await throwing.health(), {gateway: 'online', extension: 'offline'});
});

test('returns fresh canonical errors without executor-owned fields or causes', async () => {
  const owned = toolError('provider_rate_limited', {retryable: true, retryAfterMs: 25});
  owned.secret = 'do-not-leak';
  owned.cause = new Error('provider secret');
  const definition = {...registry.get('pure.chats.list'), implemented: true};
  const router = createRouter({executors: {
    gateway: executor('gateway', 'online', async () => { throw owned; })
  }});
  const caught = await router.execute(definition, {}, {}).catch(error => error);
  assert.equal(caught instanceof ToolCoreError, true);
  assert.notEqual(caught, owned);
  assert.equal(caught.code, 'provider_rate_limited');
  assert.equal(caught.retryable, true);
  assert.equal(caught.retryAfterMs, 25);
  assert.equal(Object.hasOwn(caught, 'secret'), false);
  assert.equal(Object.hasOwn(caught, 'cause'), false);

  const hostile = new Proxy(owned, {ownKeys() { throw new Error('proxy secret'); }});
  const rejected = createRouter({executors: {
    gateway: executor('gateway', 'online', async () => { throw hostile; })
  }});
  await assert.rejects(rejected.execute(definition, {}, {}), error =>
    error instanceof ToolCoreError && error.code === 'executor_rejected' && !Object.hasOwn(error, 'secret')
  );
});

test('health-based failover reaches a secondary only for safe operations', async () => {
  let extensionCalls = 0;
  const router = createRouter({executors: {
    gateway: executor('gateway', 'offline'),
    extension: executor('extension', 'online', async () => { extensionCalls += 1; return 'ok'; })
  }});
  const safe = {...registry.get('pure.chats.list'), implemented: true, executors: ['gateway', 'extension']};
  assert.equal((await router.execute(safe, {}, {})).executor, 'extension');
  const mutation = {...registry.get('pure.discovery.reaction.like'), implemented: true, executors: ['gateway', 'extension']};
  await assert.rejects(router.execute(mutation, {}, {}), {code: 'gateway_offline'});
  assert.equal(extensionCalls, 1);
});

test('reauth and compatibility health states fail exactly without failover', async () => {
  const definition = {...registry.get('pure.chats.list'), implemented: true, executors: ['gateway', 'extension']};
  for (const state of ['reauth_required', 'compatibility_required']) {
    let extensionCalls = 0;
    const router = createRouter({executors: {
      gateway: executor('gateway', state),
      extension: executor('extension', 'online', async () => { extensionCalls += 1; })
    }});
    await assert.rejects(router.execute(definition, {}, {}), error =>
      error instanceof ToolCoreError && error.code === state && error.message === state
    );
    assert.equal(extensionCalls, 0);
  }
});

test('uses only a declared online preferred executor and otherwise preserves gateway order', async () => {
  const definition = {...registry.get('pure.chats.list'), implemented: true, executors: ['gateway', 'extension']};
  const online = createRouter({executors: {
    gateway: executor('gateway'), extension: executor('extension')
  }});
  assert.equal((await online.execute(definition, {}, {preferredExecutor: 'extension'})).executor, 'extension');

  const offlinePreferred = createRouter({executors: {
    gateway: executor('gateway'), extension: executor('extension', 'offline')
  }});
  assert.equal((await offlinePreferred.execute(definition, {}, {preferredExecutor: 'extension'})).executor, 'gateway');
  assert.equal((await online.execute({...definition, executors: ['gateway']}, {}, {preferredExecutor: 'extension'})).executor, 'gateway');
});

test('rejects null, invalid, accessor, and hostile preferred executor contexts canonically', async () => {
  const definition = {...registry.get('pure.chats.list'), implemented: true};
  const router = createRouter({executors: {gateway: executor('gateway')}});
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'preferredExecutor', {
    enumerable: true,
    get() { getterCalls += 1; return 'gateway'; }
  });
  const hostile = new Proxy({}, {getOwnPropertyDescriptor() { throw new Error('context secret'); }});
  for (const context of [null, {preferredExecutor: 'other'}, accessor, hostile]) {
    await assert.rejects(router.execute(definition, {}, context), error =>
      error instanceof ToolCoreError && error.code === 'invalid_input' && error.message === 'invalid_input'
    );
  }
  assert.equal(getterCalls, 0);
});

test('preserves the primary offline error when every declared executor is offline', async () => {
  const router = createRouter({executors: {
    gateway: executor('gateway', 'offline'), extension: executor('extension', 'offline')
  }});
  const definition = {...registry.get('pure.chats.list'), implemented: true, executors: ['gateway', 'extension']};
  await assert.rejects(router.execute(definition, {}, {}), {code: 'gateway_offline'});
});

test('ignores hostile executor descriptors without invoking getters or leaking errors', async () => {
  let getterCalls = 0;
  const accessorExecutor = Object.defineProperty({}, 'health', {
    get() { getterCalls += 1; throw new Error('getter secret'); }
  });
  Object.defineProperty(accessorExecutor, 'execute', {value: async () => 'bad'});
  const proxyExecutor = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('descriptor secret'); }
  });
  const router = createRouter({executors: {gateway: accessorExecutor, extension: proxyExecutor}});
  assert.deepEqual(await router.health(), {gateway: 'offline', extension: 'offline'});
  assert.equal(getterCalls, 0);

  let optionsGetterCalls = 0;
  const options = Object.defineProperty({}, 'executors', {
    get() { optionsGetterCalls += 1; throw new Error('options secret'); }
  });
  assert.deepEqual(await createRouter(options).health(), {gateway: 'offline', extension: 'offline'});
  assert.equal(optionsGetterCalls, 0);
});

test('preserves stateful this semantics for own executor methods', async () => {
  const stateful = {
    state: 'online',
    calls: 0,
    async health() { return this.state; },
    async execute(operation) {
      this.calls += 1;
      return {operation, calls: this.calls};
    }
  };
  const router = createRouter({executors: {gateway: stateful}});
  const definition = {...registry.get('pure.chats.list'), implemented: true};
  assert.deepEqual((await router.execute(definition, {}, {})).data, {
    operation: 'pure.chats.list', calls: 1
  });
  assert.equal(stateful.calls, 1);
});

test('supports class executors through prototype data methods', async () => {
  class StatefulExecutor {
    constructor() {
      this.state = 'online';
      this.calls = 0;
    }
    async health() { return this.state; }
    async execute(operation) {
      this.calls += 1;
      return `${operation}:${this.calls}`;
    }
  }
  const instance = new StatefulExecutor();
  const router = createRouter({executors: {gateway: instance}});
  const definition = {...registry.get('pure.chats.list'), implemented: true};
  assert.equal((await router.execute(definition, {}, {})).data, 'pure.chats.list:1');
  assert.equal(instance.calls, 1);
});

test('rejects forged offline errors without reaching the secondary executor', async () => {
  const definition = {...registry.get('pure.chats.list'), implemented: true, executors: ['gateway', 'extension']};
  const forged = [
    {code: 'gateway_offline', retryable: true},
    Object.assign(Object.create(ToolCoreError.prototype), {code: 'gateway_offline', retryable: true})
  ];
  for (const supplied of forged) {
    let extensionCalls = 0;
    const router = createRouter({executors: {
      gateway: executor('gateway', 'online', async () => { throw supplied; }),
      extension: executor('extension', 'online', async () => { extensionCalls += 1; })
    }});
    await assert.rejects(router.execute(definition, {}, {}), error =>
      error instanceof ToolCoreError && error.code === 'executor_rejected' && error !== supplied
    );
    assert.equal(extensionCalls, 0);
  }
});

test('returns the primary runtime offline error when the secondary is also runtime offline', async () => {
  const gatewayOwned = toolError('gateway_offline', {retryable: true, retryAfterMs: 17});
  const extensionOwned = toolError('extension_offline', {retryable: true});
  const router = createRouter({executors: {
    gateway: executor('gateway', 'online', async () => { throw gatewayOwned; }),
    extension: executor('extension', 'online', async () => { throw extensionOwned; })
  }});
  const definition = {...registry.get('pure.chats.list'), implemented: true, executors: ['gateway', 'extension']};
  const caught = await router.execute(definition, {}, {}).catch(error => error);
  assert.equal(caught instanceof ToolCoreError, true);
  assert.equal(caught.code, 'gateway_offline');
  assert.equal(caught.retryable, true);
  assert.equal(caught.retryAfterMs, 17);
  assert.notEqual(caught, gatewayOwned);
  assert.notEqual(caught, extensionOwned);
});

test('preserves a meaningful canonical secondary runtime failure', async () => {
  const secondaryOwned = toolError('provider_rejected');
  secondaryOwned.secret = 'do-not-leak';
  const router = createRouter({executors: {
    gateway: executor('gateway', 'online', async () => { throw toolError('gateway_offline'); }),
    extension: executor('extension', 'online', async () => { throw secondaryOwned; })
  }});
  const definition = {...registry.get('pure.chats.list'), implemented: true, executors: ['gateway', 'extension']};
  const caught = await router.execute(definition, {}, {}).catch(error => error);
  assert.equal(caught.code, 'provider_rejected');
  assert.notEqual(caught, secondaryOwned);
  assert.equal(Object.hasOwn(caught, 'secret'), false);
});

test('reports each attempted executor through an optional internal observer', async () => {
  const attempts = [];
  const router = createRouter({executors: {
    gateway: executor('gateway', 'online', async () => { throw toolError('gateway_offline'); }),
    extension: executor('extension', 'online', async () => 'ok')
  }});
  const definition = {...registry.get('pure.chats.list'), implemented: true, executors: ['gateway', 'extension']};
  const result = await router.execute(definition, {}, {}, name => attempts.push(name));
  assert.equal(result.executor, 'extension');
  assert.deepEqual(attempts, ['gateway', 'extension']);
});
