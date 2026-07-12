import assert from 'node:assert/strict';
import test from 'node:test';

import {authorize, confirmationBinding, createRegistry, CORE_TOOL_DEFINITIONS} from '../src/index.js';

const registry = createRegistry(CORE_TOOL_DEFINITIONS);
const context = {callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']};

test('allows authorized reads without confirmation', async () => {
  const definition = registry.get('pure.chats.list');
  await assert.doesNotReject(authorize(definition, {}, context));
});

test('denies missing scopes before executor selection', async () => {
  const definition = registry.get('pure.discovery.reaction.like');
  await assert.rejects(authorize(definition, {userId: 'user-1'}, context), {code: 'permission_denied'});
});

test('binds dangerous confirmation to exact caller, account, operation, and arguments', async () => {
  const definition = registry.get('pure.matches.block');
  const privileged = {
    callerId: 'agent-1', accountId: 'account-1',
    scopes: ['pure:account:dangerous'], confirmationToken: 'confirm-1'
  };
  let observed;
  await authorize(definition, {matchId: 'match-1'}, privileged, async input => {
    observed = input;
    return true;
  });
  assert.equal(observed.token, 'confirm-1');
  assert.equal(observed.binding, confirmationBinding({
    callerId: 'agent-1', accountId: 'account-1',
    operation: 'pure.matches.block', schemaVersion: '1', args: {matchId: 'match-1'}
  }));
  await assert.rejects(
    authorize(definition, {matchId: 'match-2'}, privileged, async () => false),
    {code: 'confirmation_required'}
  );
});

test('rejects malformed caller context without leaking supplied values', async () => {
  const secret = 'fixture-policy-secret';
  const definition = registry.get('pure.chats.list');
  await assert.rejects(authorize(definition, {}, {callerId: secret, accountId: '', scopes: []}), error => {
    assert.equal(error.code, 'permission_denied');
    return !String(error).includes(secret);
  });
});
