import assert from 'node:assert/strict';
import test from 'node:test';

import {createRegistry, createRouter, CORE_TOOL_DEFINITIONS, toolError} from '../src/index.js';

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
