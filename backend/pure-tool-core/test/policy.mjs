import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {authorize, confirmationBinding, createRegistry, CORE_TOOL_DEFINITIONS} from '../src/index.js';

const registry = createRegistry(CORE_TOOL_DEFINITIONS);
const context = {callerId: 'agent-1', accountId: 'account-1', scopes: ['pure:read']};
const EXPECTED_BINDING = '["object",[[["string","accountId"],["string","account-1"]],[["string","args"],["object",[[["string","matchId"],["string","match-1"]]]]],[['
  + '"string","callerId"],["string","agent-1"]],[["string","operation"],["string","pure.matches.block"]],[["string","schemaVersion"],["string","1"]]]]';

async function rejectsWithoutLeak(promise, code, secrets = []) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    assert.equal('cause' in error, false);
    for (const secret of secrets) {
      assert.equal(String(error).includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
    }
    return true;
  });
}

test('allows authorized reads without confirmation', async () => {
  const definition = registry.get('pure.chats.list');
  await assert.doesNotReject(authorize(definition, {}, context));
});

test('accepts transparent proxies that yield safe own-data snapshots', async () => {
  const definition = registry.get('pure.chats.list');
  await assert.doesNotReject(authorize(definition, {}, new Proxy({...context}, {})));
  await assert.doesNotReject(authorize(definition, {}, {
    ...context,
    scopes: new Proxy(['pure:read'], {})
  }));
});

test('denies missing scopes before executor selection', async () => {
  const definition = registry.get('pure.discovery.reaction.like');
  await assert.rejects(authorize(definition, {userId: 'user-1'}, context), {code: 'permission_denied'});
});

test('emits a literal canonical binding independent of object insertion order', () => {
  assert.equal(confirmationBinding({
    callerId: 'agent-1', accountId: 'account-1',
    operation: 'pure.matches.block', schemaVersion: '1', args: {matchId: 'match-1'}
  }), EXPECTED_BINDING);
  assert.equal(confirmationBinding({
    args: {matchId: 'match-1'}, schemaVersion: '1',
    operation: 'pure.matches.block', accountId: 'account-1', callerId: 'agent-1'
  }), EXPECTED_BINDING);
});

test('binds dangerous confirmation to exact caller, account, operation, schema, and arguments', async () => {
  const definition = registry.get('pure.matches.block');
  const privileged = {
    callerId: 'agent-1', accountId: 'account-1',
    scopes: ['pure:account:dangerous'], confirmationToken: 'confirm-1'
  };
  const verifier = async ({token, binding}) => token === 'confirm-1' && binding === EXPECTED_BINDING;
  await assert.doesNotReject(authorize(definition, {matchId: 'match-1'}, privileged, verifier));

  const variants = [
    {...privileged, callerId: 'agent-2'},
    {...privileged, accountId: 'account-2'}
  ];
  for (const variant of variants) {
    await assert.rejects(authorize(definition, {matchId: 'match-1'}, variant, verifier), {
      code: 'confirmation_required'
    });
  }
  await assert.rejects(
    authorize(registry.get('pure.matches.report'), {matchId: 'match-1'}, privileged, verifier),
    {code: 'confirmation_required'}
  );
  await assert.rejects(authorize(definition, {matchId: 'match-2'}, privileged, verifier), {
    code: 'confirmation_required'
  });

  const base = {
    callerId: 'agent-1', accountId: 'account-1',
    operation: 'pure.matches.block', schemaVersion: '1', args: {matchId: 'match-1'}
  };
  assert.notEqual(confirmationBinding({...base, callerId: 'agent-2'}), EXPECTED_BINDING);
  assert.notEqual(confirmationBinding({...base, accountId: 'account-2'}), EXPECTED_BINDING);
  assert.notEqual(confirmationBinding({...base, operation: 'pure.matches.report'}), EXPECTED_BINDING);
  assert.notEqual(confirmationBinding({...base, schemaVersion: '2'}), EXPECTED_BINDING);
  assert.notEqual(confirmationBinding({...base, args: {matchId: 'match-2'}}), EXPECTED_BINDING);
});

test('rejects malformed caller context without leaking supplied values', async () => {
  const secret = 'fixture-policy-secret';
  const definition = registry.get('pure.chats.list');
  await assert.rejects(authorize(definition, {}, {callerId: secret, accountId: '', scopes: []}), error => {
    assert.equal(error.code, 'permission_denied');
    return !String(error).includes(secret);
  });
});

test('sanitizes null, accessor, revoked, throwing-proxy, inherited, and hostile-scope contexts', async () => {
  const definition = registry.get('pure.chats.list');
  const secret = 'fixture-hostile-context-secret';
  let callerGetterCalled = false;
  const accessorContext = {accountId: 'account-1', scopes: ['pure:read']};
  Object.defineProperty(accessorContext, 'callerId', {
    enumerable: true,
    get() {
      callerGetterCalled = true;
      throw new Error(secret);
    }
  });
  const proxyContext = new Proxy({}, {ownKeys() { throw new Error(secret); }});
  const revokedContext = Proxy.revocable({...context}, {});
  revokedContext.revoke();
  const inheritedContext = Object.create(context);

  let scopeGetterCalled = false;
  const accessorScopes = [];
  Object.defineProperty(accessorScopes, '0', {
    enumerable: true,
    get() {
      scopeGetterCalled = true;
      throw new Error(secret);
    }
  });
  const customScopes = ['pure:read'];
  Object.defineProperty(customScopes, Symbol.iterator, {
    get() {
      throw new Error(secret);
    }
  });
  const sparseScopes = new Array(1);
  const proxyScopes = new Proxy(['pure:read'], {ownKeys() { throw new Error(secret); }});

  const hostile = [
    null,
    accessorContext,
    proxyContext,
    revokedContext.proxy,
    inheritedContext,
    {...context, scopes: accessorScopes},
    {...context, scopes: customScopes},
    {...context, scopes: sparseScopes},
    {...context, scopes: proxyScopes}
  ];
  for (const value of hostile) {
    await rejectsWithoutLeak(authorize(definition, {}, value), 'permission_denied', [secret]);
  }
  assert.equal(callerGetterCalled, false);
  assert.equal(scopeGetterCalled, false);
});

test('maps malformed dangerous tokens and verifier failures to fresh confirmation errors', async () => {
  const definition = registry.get('pure.matches.block');
  const rawSecret = 'fixture-verifier-raw-secret';
  const tokenSecret = 'fixture-confirmation-token-secret';
  const privileged = {
    callerId: 'agent-1', accountId: 'account-1',
    scopes: ['pure:account:dangerous'], confirmationToken: tokenSecret
  };
  await rejectsWithoutLeak(
    authorize(definition, {matchId: 'match-1'}, privileged, async () => { throw new Error(rawSecret); }),
    'confirmation_required',
    [rawSecret, tokenSecret]
  );
  await rejectsWithoutLeak(
    authorize(definition, {matchId: 'match-1'}, privileged, async () => ({valid: true})),
    'confirmation_required',
    [tokenSecret]
  );

  let tokenGetterCalled = false;
  const accessorToken = {...privileged};
  Object.defineProperty(accessorToken, 'confirmationToken', {
    enumerable: true,
    get() {
      tokenGetterCalled = true;
      throw new Error(rawSecret);
    }
  });
  await rejectsWithoutLeak(
    authorize(definition, {matchId: 'match-1'}, accessorToken, async () => true),
    'confirmation_required',
    [rawSecret]
  );
  assert.equal(tokenGetterCalled, false);
});

test('distinguishes positive and negative zero in confirmation bindings', () => {
  const input = {
    callerId: 'agent-1', accountId: 'account-1',
    operation: 'pure.matches.block', schemaVersion: '1'
  };
  assert.notEqual(confirmationBinding({...input, args: {value: 0}}),
    confirmationBinding({...input, args: {value: -0}}));
});

test('keeps production policy free of Node runtime imports', async () => {
  const source = await readFile(new URL('../src/policy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:from\s+|import\s*\()['"]node:/);
});
