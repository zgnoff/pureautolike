import assert from 'node:assert/strict';
import test from 'node:test';

import * as publicCore from '../src/index.js';
import {ERROR_CODES, ToolCoreError, failure, success, toolError} from '../src/index.js';
import {isToolCoreError} from '../src/errors.js';

test('publishes the stable foundation error codes', () => {
  assert(ERROR_CODES.has('invalid_input'));
  assert(ERROR_CODES.has('permission_denied'));
  assert(ERROR_CODES.has('confirmation_required'));
  assert(ERROR_CODES.has('extension_offline'));
  assert(ERROR_CODES.has('gateway_offline'));
  assert(ERROR_CODES.has('capability_not_implemented'));
  assert(ERROR_CODES.has('operation_uncertain'));
});

test('prevents consumers from mutating the published error codes', () => {
  assert([...ERROR_CODES].includes('invalid_input'));
  assert.throws(() => ERROR_CODES.add('made_up_error'), {name: 'TypeError'});
  assert.throws(() => ERROR_CODES.delete('invalid_input'), {name: 'TypeError'});
  assert.throws(() => ERROR_CODES.clear(), {name: 'TypeError'});
  assert.throws(() => toolError('made_up_error'), {name: 'TypeError'});
});

test('does not expose mutable error codes through valueOf', () => {
  assert.throws(() => ERROR_CODES.valueOf().add('made_up_error'), {name: 'TypeError'});
  assert.equal(ERROR_CODES.valueOf(), ERROR_CODES);
  assert.throws(() => toolError('made_up_error'), {name: 'TypeError'});
});

test('creates frozen success results with stable metadata', () => {
  const result = success({state: 'active'}, {
    executor: 'gateway', requestId: 'req-1', capabilityVersion: '1'
  });
  assert.deepEqual(result, {
    ok: true,
    data: {state: 'active'},
    executor: 'gateway',
    requestId: 'req-1',
    capabilityVersion: '1'
  });
  assert(Object.isFrozen(result));
});

test('does not echo provider text through external failures', () => {
  const secret = 'fixture-auth-secret-must-not-escape';
  const error = toolError('provider_rejected', {retryable: false, cause: new Error(secret)});
  assert(error instanceof ToolCoreError);
  const result = failure(error, {requestId: 'req-2'});
  assert.equal(result.error, 'provider_rejected');
  assert.equal(result.retryable, false);
  assert(!JSON.stringify(result).includes(secret));
  assert(!String(error).includes(secret));
});

test('does not retain provider errors on public error properties', () => {
  const secret = 'fixture-provider-cause-must-not-be-reachable';
  const error = toolError('provider_rejected', {cause: new Error(secret)});
  assert.equal(Object.hasOwn(error, 'cause'), false);
  for (const key of Reflect.ownKeys(error)) {
    assert(!String(error[key]).includes(secret));
  }
  assert(!JSON.stringify(error).includes(secret));
});

test('rejects unknown error codes', () => {
  assert.throws(() => toolError('made_up_error'), {name: 'TypeError'});
});

test('brands only errors constructed by the core error contract', () => {
  const direct = new ToolCoreError('gateway_offline');
  const factory = toolError('extension_offline');
  const forged = Object.assign(Object.create(ToolCoreError.prototype), {
    code: 'gateway_offline', retryable: true
  });
  assert.equal(isToolCoreError(direct), true);
  assert.equal(isToolCoreError(factory), true);
  assert.equal(isToolCoreError(new Proxy(factory, {})), false);
  assert.equal(isToolCoreError(forged), false);
  assert.equal(isToolCoreError({code: 'gateway_offline', retryable: true}), false);
  assert.equal(Object.hasOwn(publicCore, 'isToolCoreError'), false);
});
