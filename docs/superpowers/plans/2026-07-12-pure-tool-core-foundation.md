# Pure Tool Core Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reusable, fixture-safe Pure Tool Core foundation: canonical contracts, complete capability registry, authorization and confirmation policy, executor routing, and a single invocation API ready for MCP and application adapters.

**Architecture:** Add a standalone dependency-free ESM package under `backend/pure-tool-core`. The package owns stable definitions and orchestration but contains no Pure endpoint code, credentials, UI, Telegram code, or MCP transport. Gateway and extension executors will plug into the core through a narrow `execute(operation, args, context)` interface in later plans.

**Tech Stack:** Node.js 24+, JavaScript ESM, `node:test`, `node:assert/strict`, existing root validation scripts.

## Global Constraints

- MCP is an interface over `Pure Tool Core`; Pure behavior must not be implemented in the MCP transport.
- The product application must be able to call the core directly without MCP.
- The core must never expose Pure credentials, cookies, authorization headers, protected media URLs, raw provider errors, message bodies, or media in logs or model-facing error objects.
- The core must reject arbitrary URLs, methods, headers, and unregistered request shapes.
- Server-capable operations prefer `gateway`; extension-only operations return `extension_offline` when the extension executor is unavailable.
- Irreversible and account-sensitive operations require a confirmation bound to caller, account, operation, and normalized arguments.
- Unknown or not-yet-fixtured Pure operations return `capability_not_implemented`; they are never guessed.
- Every operation definition uses a stable dotted name, schema version `1`, explicit scopes, confirmation class, executors, mutation class, and safe-failover policy.
- The foundation adds no third-party runtime dependencies.
- Existing unrelated working-tree changes must not be staged or modified.

---

## File map

### New package

- `backend/pure-tool-core/package.json` — standalone ESM package metadata and test script.
- `backend/pure-tool-core/src/errors.js` — stable external error codes and credential-safe error type.
- `backend/pure-tool-core/src/results.js` — frozen success/failure result envelopes.
- `backend/pure-tool-core/src/schema.js` — bounded JSON-compatible argument normalization and the foundation JSON-schema subset validator.
- `backend/pure-tool-core/src/catalog.js` — complete version-1 canonical operation catalog.
- `backend/pure-tool-core/src/registry.js` — catalog validation, indexing, lookup, and capability listing.
- `backend/pure-tool-core/src/policy.js` — scopes, dangerous-operation confirmation binding, and authorization.
- `backend/pure-tool-core/src/router.js` — executor health checks, deterministic selection, and safe failover.
- `backend/pure-tool-core/src/core.js` — invocation pipeline and privacy-safe audit events.
- `backend/pure-tool-core/src/index.js` — public exports only.

### New tests

- `backend/pure-tool-core/test/contracts.mjs` — result and error contracts.
- `backend/pure-tool-core/test/schema.mjs` — input bounds, normalization, and schema validation.
- `backend/pure-tool-core/test/registry.mjs` — catalog completeness and registry invariants.
- `backend/pure-tool-core/test/policy.mjs` — permission and confirmation matrix.
- `backend/pure-tool-core/test/router.mjs` — routing and failover behavior.
- `backend/pure-tool-core/test/core.mjs` — end-to-end core invocation and privacy checks.
- `backend/pure-tool-core/test/public-api.mjs` — exported API stability.

### Existing files

- `package.json` — include the tool-core suite in root `npm run validate`.
- `tests/audit-clean.mjs` — include the new source and tests in secret/content leakage scanning if the current scanner uses an explicit path allowlist.
- `docs/extension-architecture.md` — document the new shared core boundary after code exists.

---

### Task 1: Stable result and error contracts

**Files:**

- Create: `backend/pure-tool-core/package.json`
- Create: `backend/pure-tool-core/src/errors.js`
- Create: `backend/pure-tool-core/src/results.js`
- Create: `backend/pure-tool-core/test/contracts.mjs`

**Interfaces:**

- Produces: `ERROR_CODES`, `ToolCoreError`, `toolError(code, options)`, `success(data, meta)`, `failure(error, meta)`.
- `ToolCoreError` carries only `code`, optional numeric `retryAfterMs`, and boolean `retryable`; it never copies provider error text.
- Result envelopes use camelCase internally. Future MCP and HTTP transports may transform casing at their boundary.

- [ ] **Step 1: Create package metadata and the failing contract test**

Create `backend/pure-tool-core/package.json`:

```json
{
  "name": "@pureautolike/tool-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "exports": "./src/index.js",
  "scripts": {
    "test": "node --test test/*.mjs",
    "check": "node --check src/errors.js && node --check src/results.js && node --check src/schema.js && node --check src/catalog.js && node --check src/registry.js && node --check src/policy.js && node --check src/router.js && node --check src/core.js && node --check src/index.js"
  }
}
```

Create `backend/pure-tool-core/test/contracts.mjs`:

```js
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
  const secret = 'Bearer fixture-secret-must-not-escape';
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
```

- [ ] **Step 2: Run the contract test and verify the missing module failure**

Run:

```bash
node --test backend/pure-tool-core/test/contracts.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `backend/pure-tool-core/src/index.js`.

- [ ] **Step 3: Implement credential-safe errors and frozen result envelopes**

Create `backend/pure-tool-core/src/errors.js`:

```js
const CODES = [
  'invalid_input',
  'permission_denied',
  'confirmation_required',
  'extension_offline',
  'gateway_offline',
  'reauth_required',
  'capability_not_implemented',
  'provider_rate_limited',
  'provider_rejected',
  'media_expired',
  'compatibility_required',
  'result_too_large',
  'operation_uncertain',
  'operation_not_found',
  'executor_rejected'
];

export const ERROR_CODES = new Set(CODES);

export class ToolCoreError extends Error {
  constructor(code, {retryable = false, retryAfterMs = null, cause} = {}) {
    if (!ERROR_CODES.has(code)) throw new TypeError('Unknown tool-core error code');
    super(code, cause ? {cause} : undefined);
    this.name = 'ToolCoreError';
    this.code = code;
    this.retryable = retryable === true;
    if (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs = retryAfterMs;
  }
}

export function toolError(code, options) {
  return new ToolCoreError(code, options);
}
```

Create `backend/pure-tool-core/src/results.js`:

```js
import {ToolCoreError, toolError} from './errors.js';

function metadata(meta = {}) {
  const output = {};
  if (typeof meta.executor === 'string' && meta.executor) output.executor = meta.executor;
  if (typeof meta.requestId === 'string' && meta.requestId) output.requestId = meta.requestId;
  if (typeof meta.capabilityVersion === 'string' && meta.capabilityVersion) {
    output.capabilityVersion = meta.capabilityVersion;
  }
  return output;
}

export function success(data, meta = {}) {
  return Object.freeze({ok: true, data, ...metadata(meta)});
}

export function failure(error, meta = {}) {
  const safe = error instanceof ToolCoreError ? error : toolError('executor_rejected');
  const output = {
    ok: false,
    error: safe.code,
    retryable: safe.retryable,
    ...metadata(meta)
  };
  if (Number.isSafeInteger(safe.retryAfterMs)) output.retryAfterMs = safe.retryAfterMs;
  return Object.freeze(output);
}
```

Temporarily create `backend/pure-tool-core/src/index.js`:

```js
export {ERROR_CODES, ToolCoreError, toolError} from './errors.js';
export {failure, success} from './results.js';
```

- [ ] **Step 4: Run the contract test**

Run:

```bash
node --test backend/pure-tool-core/test/contracts.mjs
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit the contract slice**

```bash
git add backend/pure-tool-core/package.json backend/pure-tool-core/src/errors.js backend/pure-tool-core/src/results.js backend/pure-tool-core/src/index.js backend/pure-tool-core/test/contracts.mjs
git commit -m "feat: add Pure tool core contracts"
```

---

### Task 2: Bounded argument schema and normalization

**Files:**

- Create: `backend/pure-tool-core/src/schema.js`
- Create: `backend/pure-tool-core/test/schema.mjs`
- Modify: `backend/pure-tool-core/src/index.js`

**Interfaces:**

- Consumes: `toolError('invalid_input')`.
- Produces: `normalizeArgs(value, schema)` returning a recursively frozen, JSON-compatible, prototype-safe value.
- Supported schema keywords: `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`.
- Global bounds: 64 KiB serialized input, depth 8, 100 object keys, 100 array items.

- [ ] **Step 1: Write failing tests for bounds, schema checks, and prototype safety**

Create `backend/pure-tool-core/test/schema.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {normalizeArgs} from '../src/index.js';

const schema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['chatId', 'limit'],
  properties: {
    chatId: {type: 'string', minLength: 1, maxLength: 128},
    limit: {type: 'integer', minimum: 1, maximum: 100},
    kinds: {
      type: 'array', maxItems: 4,
      items: {type: 'string', enum: ['text', 'photo', 'voice', 'video']}
    }
  }
});

test('normalizes and freezes valid JSON-compatible arguments', () => {
  const result = normalizeArgs({chatId: 'chat-1', limit: 20, kinds: ['text', 'photo']}, schema);
  assert.deepEqual(result, {chatId: 'chat-1', limit: 20, kinds: ['text', 'photo']});
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.kinds));
});

test('rejects missing, additional, malformed, and oversized arguments', () => {
  const invalid = [
    {chatId: 'chat-1'},
    {chatId: 'chat-1', limit: 0},
    {chatId: 'chat-1', limit: 20, unknown: true},
    {chatId: 'chat-1', limit: 20, kinds: ['audio']},
    {chatId: 'x'.repeat(129), limit: 20},
    {chatId: 'chat-1', limit: 20, kinds: Array(101).fill('text')},
    {chatId: 'x'.repeat(70 * 1024), limit: 20}
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeArgs(value, schema), {code: 'invalid_input'});
  }
});

test('copies own enumerable data without preserving attacker prototypes', () => {
  const value = Object.create({admin: true});
  value.chatId = 'chat-1';
  value.limit = 20;
  const result = normalizeArgs(value, schema);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal('admin' in result, false);
});
```

- [ ] **Step 2: Run the schema tests and verify they fail**

Run:

```bash
node --test backend/pure-tool-core/test/schema.mjs
```

Expected: FAIL because `normalizeArgs` is not exported.

- [ ] **Step 3: Implement the bounded schema subset**

Create `backend/pure-tool-core/src/schema.js` with these public constants and functions:

```js
import {toolError} from './errors.js';

export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_DEPTH = 8;
export const MAX_KEYS = 100;
export const MAX_ITEMS = 100;

function invalid() {
  throw toolError('invalid_input');
}

function checkNumber(value, schema, integer) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) invalid();
  if (typeof schema.minimum === 'number' && value < schema.minimum) invalid();
  if (typeof schema.maximum === 'number' && value > schema.maximum) invalid();
  return value;
}

function copy(value, schema, depth) {
  if (depth > MAX_DEPTH || !schema || typeof schema !== 'object') invalid();
  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) invalid();
  if (schema.type === 'string') {
    if (typeof value !== 'string') invalid();
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) invalid();
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) invalid();
    return value;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') invalid();
    return value;
  }
  if (schema.type === 'number') return checkNumber(value, schema, false);
  if (schema.type === 'integer') return checkNumber(value, schema, true);
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > MAX_ITEMS) invalid();
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) invalid();
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) invalid();
    return Object.freeze(value.map(item => copy(item, schema.items, depth + 1)));
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const keys = Object.keys(value);
    if (keys.length > MAX_KEYS) invalid();
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) invalid();
    }
    const output = Object.create(null);
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        if (schema.additionalProperties === false) invalid();
        output[key] = copy(value[key], schema.additionalProperties, depth + 1);
      } else {
        output[key] = copy(value[key], properties[key], depth + 1);
      }
    }
    return Object.freeze(output);
  }
  invalid();
}

export function normalizeArgs(value, schema) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_) {
    invalid();
  }
  if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > MAX_INPUT_BYTES) invalid();
  return copy(value, schema, 0);
}
```

Export `normalizeArgs`, `MAX_INPUT_BYTES`, `MAX_DEPTH`, `MAX_KEYS`, and `MAX_ITEMS` from `src/index.js`.

- [ ] **Step 4: Run the schema and contract tests**

Run:

```bash
node --test backend/pure-tool-core/test/contracts.mjs backend/pure-tool-core/test/schema.mjs
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit the schema slice**

```bash
git add backend/pure-tool-core/src/schema.js backend/pure-tool-core/src/index.js backend/pure-tool-core/test/schema.mjs
git commit -m "feat: validate Pure tool arguments"
```

---

### Task 3: Complete version-1 capability catalog and registry

**Files:**

- Create: `backend/pure-tool-core/src/catalog.js`
- Create: `backend/pure-tool-core/src/registry.js`
- Create: `backend/pure-tool-core/test/registry.mjs`
- Modify: `backend/pure-tool-core/src/index.js`

**Interfaces:**

- Produces: `CORE_TOOL_DEFINITIONS`, `createRegistry(definitions)`, `registry.get(name)`, `registry.list()`, `registry.capabilities(health)`.
- Definition shape: `{name, schemaVersion, description, executors, scopes, confirmation, mutation, safeFailover, implemented, inputSchema}`.
- `confirmation` is one of `none`, `grant`, `dangerous`.
- `mutation` is one of `read`, `idempotent`, `non_idempotent`, `destructive`.
- A registry rejects duplicates, invalid names, missing schemas, incompatible executor/failover combinations, and dangerous operations without `dangerous` confirmation.

- [ ] **Step 1: Write failing catalog and registry tests**

Create `backend/pure-tool-core/test/registry.mjs`:

```js
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
```

- [ ] **Step 2: Run the registry test and verify it fails**

Run:

```bash
node --test backend/pure-tool-core/test/registry.mjs
```

Expected: FAIL because the catalog exports do not exist.

- [ ] **Step 3: Implement the canonical catalog**

Create `backend/pure-tool-core/src/catalog.js`. Use one frozen helper and the exact version-1 names below:

```js
const EMPTY_INPUT = Object.freeze({type: 'object', properties: {}, additionalProperties: false});

const idInput = key => Object.freeze({
  type: 'object', additionalProperties: false, required: [key],
  properties: {[key]: {type: 'string', minLength: 1, maxLength: 128}}
});

const pageInput = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    cursor: {type: 'string', minLength: 1, maxLength: 512},
    limit: {type: 'integer', minimum: 1, maximum: 100}
  }
});

function define(name, options = {}) {
  return Object.freeze({
    name,
    schemaVersion: '1',
    description: options.description || name,
    executors: Object.freeze(options.executors || ['gateway']),
    scopes: Object.freeze(options.scopes || ['pure:read']),
    confirmation: options.confirmation || 'none',
    mutation: options.mutation || 'read',
    safeFailover: options.safeFailover === true,
    implemented: options.implemented === true,
    inputSchema: options.inputSchema || EMPTY_INPUT
  });
}

const read = (name, options = {}) => define(name, {...options, mutation: 'read', safeFailover: true});
const grant = (name, scope, options = {}) => define(name, {
  ...options, scopes: [scope], confirmation: 'grant', mutation: 'non_idempotent'
});
const dangerous = (name, scope, options = {}) => define(name, {
  ...options, scopes: [scope], confirmation: 'dangerous', mutation: 'destructive'
});

export const CORE_TOOL_DEFINITIONS = Object.freeze([
  read('system.capabilities.list', {executors: ['core'], implemented: true}),
  read('system.operation.get', {executors: ['core'], inputSchema: idInput('requestId')}),
  read('system.workflow.get', {executors: ['core'], inputSchema: idInput('workflowId')}),
  grant('system.workflow.cancel', 'pure:read', {executors: ['core'], inputSchema: idInput('workflowId')}),
  grant('system.confirmation.resolve', 'pure:read', {executors: ['core'], inputSchema: idInput('challengeId')}),

  read('pure.session.status'),
  grant('pure.session.activate', 'pure:account:dangerous'),
  grant('pure.session.rotate', 'pure:account:dangerous'),
  grant('pure.session.reconnect', 'pure:read'),
  dangerous('pure.session.revoke', 'pure:account:dangerous'),
  dangerous('pure.session.delete', 'pure:account:dangerous'),

  read('pure.discovery.state.get'),
  read('pure.discovery.preferences.get'),
  read('pure.discovery.profile.next'),
  read('pure.discovery.profile.get', {inputSchema: idInput('userId')}),
  grant('pure.discovery.reaction.like', 'pure:react', {inputSchema: idInput('userId')}),
  grant('pure.discovery.reaction.skip', 'pure:react', {inputSchema: idInput('userId')}),
  grant('pure.discovery.workflow.start', 'pure:react'),
  grant('pure.discovery.workflow.pause', 'pure:react', {inputSchema: idInput('workflowId')}),
  grant('pure.discovery.workflow.resume', 'pure:react', {inputSchema: idInput('workflowId')}),
  grant('pure.discovery.workflow.stop', 'pure:react', {inputSchema: idInput('workflowId')}),
  read('pure.discovery.workflow.status', {inputSchema: idInput('workflowId')}),

  read('pure.matches.list', {inputSchema: pageInput}),
  read('pure.matches.get', {inputSchema: idInput('matchId')}),
  dangerous('pure.matches.block', 'pure:account:dangerous', {inputSchema: idInput('matchId')}),
  dangerous('pure.matches.report', 'pure:account:dangerous', {inputSchema: idInput('matchId')}),
  dangerous('pure.matches.unmatch', 'pure:account:dangerous', {inputSchema: idInput('matchId')}),
  dangerous('pure.matches.remove', 'pure:account:dangerous', {inputSchema: idInput('matchId')}),

  read('pure.chats.list', {inputSchema: pageInput}),
  read('pure.chats.get', {inputSchema: idInput('chatId')}),
  read('pure.chats.history.list', {inputSchema: idInput('chatId')}),
  read('pure.chats.events.list', {inputSchema: pageInput}),
  grant('pure.chats.message.send', 'pure:message', {inputSchema: idInput('chatId')}),
  grant('pure.chats.read.mark', 'pure:message', {inputSchema: idInput('chatId')}),
  dangerous('pure.chats.delete', 'pure:account:dangerous', {inputSchema: idInput('chatId')}),
  dangerous('pure.chats.clear', 'pure:account:dangerous', {inputSchema: idInput('chatId')}),

  read('pure.media.profile_photos.list', {inputSchema: idInput('userId')}),
  read('pure.media.photo.get', {inputSchema: idInput('mediaId')}),
  read('pure.media.download', {inputSchema: idInput('mediaId')}),
  grant('pure.media.upload', 'pure:media'),
  read('pure.media.transfer.status', {inputSchema: idInput('transferId')}),

  read('pure.profile.get'),
  grant('pure.profile.update', 'pure:profile:write'),
  grant('pure.profile.photos.upload', 'pure:profile:write'),
  grant('pure.profile.photos.reorder', 'pure:profile:write'),
  dangerous('pure.profile.photos.delete', 'pure:profile:write', {inputSchema: idInput('photoId')}),
  read('pure.profile.location.get'),
  dangerous('pure.profile.location.update', 'pure:profile:write'),
  dangerous('pure.profile.visibility.update', 'pure:profile:write'),

  read('extension.autolike.status', {executors: ['extension'], scopes: ['extension:control']}),
  read('extension.autolike.config.get', {executors: ['extension'], scopes: ['extension:control']}),
  grant('extension.autolike.config.update', 'extension:control', {executors: ['extension']}),
  grant('extension.autolike.start', 'extension:control', {executors: ['extension']}),
  grant('extension.autolike.pause', 'extension:control', {executors: ['extension']}),
  grant('extension.autolike.resume', 'extension:control', {executors: ['extension']}),
  grant('extension.autolike.stop', 'extension:control', {executors: ['extension']}),
  read('extension.autolike.stats', {executors: ['extension'], scopes: ['extension:control']}),

  read('extension.telegram.status', {executors: ['extension'], scopes: ['telegram:control']}),
  grant('extension.telegram.connect', 'telegram:control', {executors: ['extension']}),
  grant('extension.telegram.test', 'telegram:control', {executors: ['extension']}),
  grant('extension.telegram.pause', 'telegram:control', {executors: ['extension']}),
  grant('extension.telegram.resume', 'telegram:control', {executors: ['extension']}),
  dangerous('extension.telegram.disconnect', 'telegram:control', {executors: ['extension']}),

  read('extension.browser.status', {executors: ['extension'], scopes: ['extension:control']}),
  grant('extension.browser.tab.open', 'extension:control', {executors: ['extension']}),
  grant('extension.browser.tab.focus', 'extension:control', {executors: ['extension']}),
  grant('extension.browser.operation.request', 'extension:control', {executors: ['extension']})
]);
```

This catalog intentionally marks every executor-backed operation `implemented: false`. Only `system.capabilities.list` is implemented in the foundation; request inspection remains unavailable until a privacy-safe operational metadata store exists.

- [ ] **Step 4: Implement registry validation and capability availability**

Create `backend/pure-tool-core/src/registry.js`:

```js
import {toolError} from './errors.js';

const NAME = /^(?:pure|extension|system)(?:\.[a-z][a-z0-9_]*){2,5}$/;
const EXECUTORS = new Set(['core', 'gateway', 'extension']);
const CONFIRMATIONS = new Set(['none', 'grant', 'dangerous']);
const MUTATIONS = new Set(['read', 'idempotent', 'non_idempotent', 'destructive']);

function reject() {
  throw toolError('invalid_input');
}

function validate(definition) {
  if (!definition || typeof definition !== 'object' || !NAME.test(definition.name)) reject();
  if (definition.schemaVersion !== '1' || !Array.isArray(definition.executors) || definition.executors.length === 0) reject();
  if (!definition.executors.every(value => EXECUTORS.has(value))) reject();
  if (!Array.isArray(definition.scopes) || !CONFIRMATIONS.has(definition.confirmation)) reject();
  if (!MUTATIONS.has(definition.mutation) || !definition.inputSchema) reject();
  if (definition.mutation === 'destructive' && definition.confirmation !== 'dangerous') reject();
  if (definition.safeFailover && definition.mutation !== 'read' && definition.mutation !== 'idempotent') reject();
  return definition;
}

export function createRegistry(definitions) {
  if (!Array.isArray(definitions)) reject();
  const indexed = new Map();
  for (const definition of definitions) {
    validate(definition);
    if (indexed.has(definition.name)) reject();
    indexed.set(definition.name, definition);
  }
  const list = Object.freeze([...indexed.values()].sort((a, b) => a.name.localeCompare(b.name)));
  return Object.freeze({
    get(name) { return indexed.get(name) || null; },
    list() { return list; },
    capabilities(health = {}) {
      return list.map(definition => {
        let availability = 'available';
        if (!definition.implemented) availability = 'not_implemented';
        else if (!definition.executors.includes('core') && !definition.executors.some(name => health[name] === 'online')) {
          availability = definition.executors.includes('extension') ? 'extension_offline' : 'gateway_offline';
        }
        return Object.freeze({
          name: definition.name,
          schemaVersion: definition.schemaVersion,
          executors: definition.executors,
          scopes: definition.scopes,
          confirmation: definition.confirmation,
          availability
        });
      });
    }
  });
}
```

Export the catalog and registry from `src/index.js`.

- [ ] **Step 5: Run the registry suite**

Run:

```bash
node --test backend/pure-tool-core/test/registry.mjs
```

Expected: 3 tests pass and the catalog contains at least 55 unique operations.

- [ ] **Step 6: Commit the registry slice**

```bash
git add backend/pure-tool-core/src/catalog.js backend/pure-tool-core/src/registry.js backend/pure-tool-core/src/index.js backend/pure-tool-core/test/registry.mjs
git commit -m "feat: register complete Pure tool catalog"
```

---

### Task 4: Scope and confirmation policy

**Files:**

- Create: `backend/pure-tool-core/src/policy.js`
- Create: `backend/pure-tool-core/test/policy.mjs`
- Modify: `backend/pure-tool-core/src/index.js`

**Interfaces:**

- Consumes: normalized arguments and a registered definition.
- Produces: `confirmationBinding(input)` and `authorize(definition, args, context, confirmationVerifier)`.
- Context shape: `{callerId, accountId, scopes, confirmationToken}`.
- Confirmation verifier signature: `async ({token, binding}) => boolean`.
- The binding is a deterministic JSON string containing caller, account, operation, schema version, and normalized arguments.

- [ ] **Step 1: Write the failing permission and binding tests**

Create `backend/pure-tool-core/test/policy.mjs`:

```js
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
  const secret = 'Bearer policy-secret';
  const definition = registry.get('pure.chats.list');
  await assert.rejects(authorize(definition, {}, {callerId: secret, accountId: '', scopes: []}), error => {
    assert.equal(error.code, 'permission_denied');
    return !String(error).includes(secret);
  });
});
```

- [ ] **Step 2: Run the policy test and verify it fails**

Run:

```bash
node --test backend/pure-tool-core/test/policy.mjs
```

Expected: FAIL because policy exports do not exist.

- [ ] **Step 3: Implement deterministic binding and authorization**

Create `backend/pure-tool-core/src/policy.js`:

```js
import {toolError} from './errors.js';

function validIdentity(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort()) output[key] = stable(value[key]);
    return output;
  }
  return value;
}

export function confirmationBinding({callerId, accountId, operation, schemaVersion, args}) {
  return JSON.stringify(stable({callerId, accountId, operation, schemaVersion, args}));
}

export async function authorize(definition, args, context = {}, confirmationVerifier) {
  const scopes = Array.isArray(context.scopes) ? new Set(context.scopes) : new Set();
  if (!validIdentity(context.callerId) || !validIdentity(context.accountId)) throw toolError('permission_denied');
  if (!definition.scopes.every(scope => scopes.has(scope))) throw toolError('permission_denied');
  if (definition.confirmation !== 'dangerous') return;
  if (typeof context.confirmationToken !== 'string' || typeof confirmationVerifier !== 'function') {
    throw toolError('confirmation_required');
  }
  const binding = confirmationBinding({
    callerId: context.callerId,
    accountId: context.accountId,
    operation: definition.name,
    schemaVersion: definition.schemaVersion,
    args
  });
  let valid = false;
  try {
    valid = await confirmationVerifier({token: context.confirmationToken, binding});
  } catch (_) {}
  if (valid !== true) throw toolError('confirmation_required');
}
```

Export the policy functions from `src/index.js`.

- [ ] **Step 4: Run the policy and registry suites**

Run:

```bash
node --test backend/pure-tool-core/test/policy.mjs backend/pure-tool-core/test/registry.mjs
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit the policy slice**

```bash
git add backend/pure-tool-core/src/policy.js backend/pure-tool-core/src/index.js backend/pure-tool-core/test/policy.mjs
git commit -m "feat: enforce Pure tool permissions"
```

---

### Task 5: Executor router and safe failover

**Files:**

- Create: `backend/pure-tool-core/src/router.js`
- Create: `backend/pure-tool-core/test/router.mjs`
- Modify: `backend/pure-tool-core/src/index.js`

**Interfaces:**

- Produces: `createRouter({executors})`.
- Executor interface: `{health(): Promise<'online'|'offline'|'reauth_required'|'compatibility_required'>, execute(operation, args, context): Promise<unknown>}`.
- Router interface: `health()` and `execute(definition, args, context)` returning `{executor, data}`.
- Preferred order is `gateway`, then `extension`, unless the definition is extension-only or `context.preferredExecutor` requests an allowed online executor.
- Automatic failover occurs only for `safeFailover` operations and only when the first executor fails with `gateway_offline` or `extension_offline` before a provider mutation.

- [ ] **Step 1: Write failing routing tests**

Create `backend/pure-tool-core/test/router.mjs`:

```js
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
```

- [ ] **Step 2: Run the router tests and verify they fail**

Run:

```bash
node --test backend/pure-tool-core/test/router.mjs
```

Expected: FAIL because `createRouter` is not exported.

- [ ] **Step 3: Implement deterministic executor routing**

Create `backend/pure-tool-core/src/router.js`:

```js
import {ToolCoreError, toolError} from './errors.js';

const ALLOWED = new Set(['gateway', 'extension']);

function offlineCode(name) {
  return name === 'extension' ? 'extension_offline' : 'gateway_offline';
}

export function createRouter({executors = {}} = {}) {
  const available = Object.fromEntries(
    Object.entries(executors).filter(([name, value]) =>
      ALLOWED.has(name) && value && typeof value.health === 'function' && typeof value.execute === 'function'
    )
  );

  async function health() {
    const output = {};
    for (const name of ALLOWED) {
      if (!available[name]) output[name] = 'offline';
      else {
        try { output[name] = await available[name].health(); }
        catch (_) { output[name] = 'offline'; }
      }
    }
    return Object.freeze(output);
  }

  async function candidates(definition, context) {
    const states = await health();
    const declared = definition.executors.filter(name => ALLOWED.has(name));
    const preferred = context.preferredExecutor;
    const ordered = preferred && declared.includes(preferred)
      ? [preferred, ...declared.filter(name => name !== preferred)]
      : ['gateway', 'extension'].filter(name => declared.includes(name));
    return {states, ordered};
  }

  return Object.freeze({
    health,
    async execute(definition, args, context = {}) {
      const {states, ordered} = await candidates(definition, context);
      let lastOffline = null;
      for (let index = 0; index < ordered.length; index += 1) {
        const name = ordered[index];
        if (states[name] !== 'online') {
          lastOffline = toolError(offlineCode(name), {retryable: true});
          continue;
        }
        try {
          const data = await available[name].execute(definition.name, args, context);
          return Object.freeze({executor: name, data});
        } catch (error) {
          const safeOffline = error instanceof ToolCoreError && error.code === offlineCode(name);
          if (!definition.safeFailover || !safeOffline || index === ordered.length - 1) throw error;
          lastOffline = error;
        }
      }
      throw lastOffline || toolError(definition.executors.includes('extension') ? 'extension_offline' : 'gateway_offline', {retryable: true});
    }
  });
}
```

Export `createRouter` from `src/index.js`.

- [ ] **Step 4: Run the router suite**

Run:

```bash
node --test backend/pure-tool-core/test/router.mjs
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit the router slice**

```bash
git add backend/pure-tool-core/src/router.js backend/pure-tool-core/src/index.js backend/pure-tool-core/test/router.mjs
git commit -m "feat: route Pure tool execution"
```

---

### Task 6: End-to-end core invocation and privacy-safe audit

**Files:**

- Create: `backend/pure-tool-core/src/core.js`
- Create: `backend/pure-tool-core/test/core.mjs`
- Modify: `backend/pure-tool-core/src/index.js`

**Interfaces:**

- Consumes: registry, schema normalization, authorization, confirmation verifier, and router.
- Produces: `createToolCore(options)` with `invoke(name, args, context)`, `capabilities()`, and `health()`.
- `options`: `{definitions, executors, confirmationVerifier, audit, requestId}`.
- `audit(event)` receives only `{requestId, tool, schemaVersion, callerType, executor, resultCode, durationMs, confirmation}`.
- The core handles `system.capabilities.list` internally; no external executor sees that call.

- [ ] **Step 1: Write failing end-to-end invocation tests**

Create `backend/pure-tool-core/test/core.mjs`:

```js
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
  const secret = 'Bearer end-to-end-secret';
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
```

- [ ] **Step 2: Run the core test and verify it fails**

Run:

```bash
node --test backend/pure-tool-core/test/core.mjs
```

Expected: FAIL because `createToolCore` is not exported.

- [ ] **Step 3: Implement the invocation pipeline**

Create `backend/pure-tool-core/src/core.js`:

```js
import {ToolCoreError, toolError} from './errors.js';
import {authorize} from './policy.js';
import {createRegistry} from './registry.js';
import {failure, success} from './results.js';
import {createRouter} from './router.js';
import {normalizeArgs} from './schema.js';

function defaultRequestId() {
  return `req_${crypto.randomUUID()}`;
}

function safeCallerType(value) {
  return ['mcp', 'app', 'telegram', 'system'].includes(value) ? value : 'system';
}

export function createToolCore(options = {}) {
  const registry = createRegistry(options.definitions || []);
  const router = createRouter({executors: options.executors});
  const confirmationVerifier = options.confirmationVerifier;
  const audit = typeof options.audit === 'function' ? options.audit : () => {};
  const requestId = typeof options.requestId === 'function' ? options.requestId : defaultRequestId;

  async function capabilities() {
    return registry.capabilities(await router.health());
  }

  async function invoke(name, rawArgs = {}, context = {}) {
    const started = Date.now();
    const id = requestId();
    const definition = registry.get(name);
    let executor = 'core';
    let result;
    try {
      if (!definition) throw toolError('operation_not_found');
      const args = normalizeArgs(rawArgs, definition.inputSchema);
      await authorize(definition, args, context, confirmationVerifier);
      if (!definition.implemented) throw toolError('capability_not_implemented');
      if (definition.name === 'system.capabilities.list') {
        result = success(await capabilities(), {
          executor, requestId: id, capabilityVersion: definition.schemaVersion
        });
      } else {
        const routed = await router.execute(definition, args, context);
        executor = routed.executor;
        result = success(routed.data, {
          executor, requestId: id, capabilityVersion: definition.schemaVersion
        });
      }
    } catch (error) {
      const safe = error instanceof ToolCoreError ? error : toolError('executor_rejected');
      result = failure(safe, {executor, requestId: id, capabilityVersion: definition?.schemaVersion});
    }
    const event = Object.freeze({
      requestId: id,
      tool: typeof name === 'string' ? name : 'invalid',
      schemaVersion: definition?.schemaVersion || 'unknown',
      callerType: safeCallerType(context.callerType),
      executor,
      resultCode: result.ok ? 'ok' : result.error,
      durationMs: Math.max(0, Date.now() - started),
      confirmation: definition?.confirmation || 'none'
    });
    try { audit(event); } catch (_) {}
    return result;
  }

  return Object.freeze({invoke, capabilities, health: router.health});
}
```

Export `createToolCore` from `src/index.js`.

- [ ] **Step 4: Run all tool-core tests**

Run:

```bash
npm test --prefix backend/pure-tool-core
```

Expected: all contract, schema, registry, policy, router, and core tests pass.

- [ ] **Step 5: Commit the orchestration slice**

```bash
git add backend/pure-tool-core/src/core.js backend/pure-tool-core/src/index.js backend/pure-tool-core/test/core.mjs
git commit -m "feat: orchestrate Pure tool calls"
```

---

### Task 7: Public API lock, root validation, and architecture documentation

**Files:**

- Create: `backend/pure-tool-core/test/public-api.mjs`
- Modify: `package.json`
- Modify: `tests/audit-clean.mjs` only if its inspected paths are explicit and omit `backend/pure-tool-core`
- Modify: `docs/extension-architecture.md`

**Interfaces:**

- Locks the public package surface to the symbols introduced by Tasks 1–6.
- Root validation runs the new suite before existing integration fixtures.
- Documentation states that endpoint/protocol knowledge belongs in later executor adapters, not the core.

- [ ] **Step 1: Write the public API test**

Create `backend/pure-tool-core/test/public-api.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import * as api from '../src/index.js';

test('exports only the documented foundation API', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'CORE_TOOL_DEFINITIONS',
    'ERROR_CODES',
    'MAX_DEPTH',
    'MAX_INPUT_BYTES',
    'MAX_ITEMS',
    'MAX_KEYS',
    'ToolCoreError',
    'authorize',
    'confirmationBinding',
    'createRegistry',
    'createRouter',
    'createToolCore',
    'failure',
    'normalizeArgs',
    'success',
    'toolError'
  ]);
});
```

- [ ] **Step 2: Run the public API test**

Run:

```bash
node --test backend/pure-tool-core/test/public-api.mjs
```

Expected: PASS only when `src/index.js` exports exactly the listed symbols. Remove accidental internal exports rather than expanding the expected list.

- [ ] **Step 3: Add the tool-core suite to root validation**

In root `package.json`, prepend the following command to `scripts.validate`:

```text
node --test backend/pure-tool-core/test/*.mjs &&
```

The resulting script must begin:

```json
"validate": "node --test backend/pure-tool-core/test/*.mjs && node tests/validate-extension.mjs && ..."
```

Do not reorder or remove the existing validation commands.

- [ ] **Step 4: Extend the clean audit only if required by its current path selection**

Inspect `tests/audit-clean.mjs` with:

```bash
rg -n "backend|src|tests|roots|paths|files" tests/audit-clean.mjs
```

If it recursively starts at the repository root, make no edit. If it uses an explicit directory array, add exactly:

```js
'backend/pure-tool-core'
```

Run:

```bash
npm run audit:clean
```

Expected: PASS with no credential, raw-message, or protected-URL findings in tool-core sources or tests.

- [ ] **Step 5: Document the shared core boundary**

Append this section to `docs/extension-architecture.md`:

```markdown
## Pure Tool Core Boundary

`backend/pure-tool-core` defines canonical operations, schemas, permissions,
confirmation requirements, capability availability, result contracts, and executor
routing shared by MCP, the application, Telegram workflows, and the cloud gateway.

The core contains no Pure endpoint paths, bearer tokens, cookies, protected media
URLs, browser APIs, Telegram credentials, or MCP transport code. Pure protocol
knowledge belongs in fixture-backed gateway or extension executors. Operations
without a captured and sanitized protocol remain registered as
`capability_not_implemented`.
```

- [ ] **Step 6: Run focused syntax and test checks**

Run:

```bash
npm run check --prefix backend/pure-tool-core
npm test --prefix backend/pure-tool-core
```

Expected: syntax check exits 0 and all tool-core tests pass.

- [ ] **Step 7: Run the full repository validation**

Run:

```bash
npm run validate
npm run audit:clean
```

Expected: both commands exit 0. Any failure in an unrelated pre-existing dirty file must be documented with its exact command and output; do not overwrite unrelated work to make the suite pass.

- [ ] **Step 8: Review the foundation diff for secret and scope safety**

Run:

```bash
git diff --check
git diff -- backend/pure-tool-core package.json tests/audit-clean.mjs docs/extension-architecture.md
rg -n "authorization|bearer|cookie|private-cdn|message.body|rawUrl|fetch\(" backend/pure-tool-core
```

Expected:

- `git diff --check` reports no whitespace errors in this task's files;
- the package contains no HTTP client or arbitrary request primitive;
- matches in tests are synthetic leakage sentinels only;
- no unrelated file is included in the staged diff.

- [ ] **Step 9: Commit the integrated foundation**

```bash
git add backend/pure-tool-core/test/public-api.mjs package.json docs/extension-architecture.md
git add tests/audit-clean.mjs  # only when Step 4 required a real edit
git commit -m "test: integrate Pure tool core validation"
```

---

## Foundation completion checklist

- [ ] `backend/pure-tool-core` has zero third-party runtime dependencies.
- [ ] At least 55 canonical tools cover every domain in the approved design.
- [ ] Every unfixtured executor-backed tool reports `capability_not_implemented`.
- [ ] Invalid input and missing permission fail before executor invocation.
- [ ] Dangerous confirmation is bound to caller, account, operation, version, and normalized arguments.
- [ ] Reads prefer gateway and may fail over safely; mutations never fail over automatically.
- [ ] Extension-only operations report `extension_offline` when unavailable.
- [ ] Audit events contain no arguments, results, provider identifiers, messages, media, credentials, or protected URLs.
- [ ] Root validation and clean audit pass.
- [ ] Only plan-scoped files are committed.

## Follow-on plans

After this foundation is complete, create and approve separate plans in this order:

1. `pure-mcp-server` — MCP authentication, tool exposure, pagination, bounded results, and confirmation resources over the core.
2. `pure-extension-executor` — authenticated extension presence lease and control tools for autoliker, browser, and Telegram state.
3. `pure-read-adapter` — fixture-backed chats, complete history, profiles, targeted profile albums, events polling, and media downloads.
4. `pure-telegram-live-sync` — import, checkpoints, topic mapping, photos, and incoming media.
5. `pure-write-adapter` — captured outgoing text and media protocols, read state, idempotency, and reconciliation.
6. `pure-complete-catalog-audit` — map every remaining Pure UI action to an implemented or explicit unsupported capability.
