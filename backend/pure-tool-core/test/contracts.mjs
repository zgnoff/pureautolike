import assert from 'node:assert/strict';
import test from 'node:test';

import {ERROR_CODES, ToolCoreError, failure, success, toolError} from '../src/index.js';

test('publishes the stable foundation error codes', () => {
  assert(ERROR_CODES.has('invalid_input'));
  assert(ERROR_CODES.has('permission_denied'));
  assert(ERROR_CODES.has('confirmation_required'));
  assert(ERROR_CODES.has('extension_offline'));
  assert(ERROR_CODES.has('gateway_offline'));
  assert(ERROR_CODES.has('capability_not_implemented'));
  assert(ERROR_CODES.has('operation_uncertain'));
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

test('rejects unknown error codes', () => {
  assert.throws(() => toolError('made_up_error'), {name: 'TypeError'});
});
