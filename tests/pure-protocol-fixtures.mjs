import assert from 'node:assert/strict';
import {
  assertFixtureSafe,
  buildSafeProtocolFixture,
  PROTOCOL_FIXTURE_MAX_BYTES,
  sanitizeProtocolEvent
} from '../tools/pure-protocol-sanitize.mjs';

const seeds = [
  'Bearer fixture-auth-value',
  'session=fixture-cookie-value',
  'fixture-query-token',
  '98765432109876543210',
  'Fixture Person',
  'fixture private message'
];

const fixture = sanitizeProtocolEvent({
  kind: 'http',
  method: 'post',
  url: 'https://api.pure.app/v2/users/98765432109876543210/messages/550e8400-e29b-41d4-a716-446655440000?token=fixture-query-token&radius=25',
  requestHeaders: {
    'X-Request-ID': '98765432109876543210',
    Cookie: 'session=fixture-cookie-value',
    Authorization: 'Bearer fixture-auth-value',
    Accept: 'application/json'
  },
  requestBody: {
    profile: {
      id: '98765432109876543210',
      name: 'Fixture Person'
    },
    message: 'fixture private message',
    enabled: true,
    attempts: 2,
    tags: ['private-one', 'private-two']
  },
  response: {
    status: 201,
    headers: {'Set-Cookie': 'session=fixture-cookie-value', 'Content-Type': 'application/json'},
    body: {ok: true, nested: {token: 'fixture-query-token', code: 201}}
  }
});

assert.equal(fixture.method, 'POST');
assert.equal(fixture.host, 'api.pure.app');
assert.equal(fixture.path, '/v2/users/:id/messages/:uuid');
assert.deepEqual(fixture.queryKeys, ['radius', 'token']);
assert.deepEqual(fixture.requestHeaderNames, ['accept', 'authorization', 'cookie', 'x-request-id']);
assert.deepEqual(fixture.responseHeaderNames, ['content-type', 'set-cookie']);
assert.deepEqual(fixture.requestBody, {
  type: 'object',
  keys: ['attempts', 'enabled', 'message', 'profile', 'tags'],
  fields: {
    attempts: {type: 'number'},
    enabled: {type: 'boolean'},
    message: {type: 'string'},
    profile: {
      type: 'object',
      keys: ['id', 'name'],
      fields: {
        id: {type: 'string'},
        name: {type: 'string'}
      }
    },
    tags: {type: 'array', itemTypes: ['string']}
  }
});
assert.deepEqual(fixture.response.body.fields.nested, {
  type: 'object',
  keys: ['code', 'token'],
  fields: {
    code: {type: 'number'},
    token: {type: 'string'}
  }
});

const serialized = JSON.stringify(fixture);
for (const seed of seeds) assert.equal(serialized.includes(seed), false);
assert.doesNotThrow(() => assertFixtureSafe(fixture));
for (const seed of seeds) {
  assert.throws(
    () => assertFixtureSafe({method: 'GET', leaked: seed}),
    /unsafe/i
  );
}

const excessive = {};
let cursor = excessive;
for (let index = 0; index < 20; index += 1) {
  cursor[`level${index}`] = {};
  cursor = cursor[`level${index}`];
}
const bounded = sanitizeProtocolEvent({
  method: 'GET',
  url: 'https://pure.app/api/feed',
  body: excessive
});
assert.ok(JSON.stringify(bounded).length < 5000);
assert.doesNotThrow(() => assertFixtureSafe(bounded));

const adversarialPath = sanitizeProtocolEvent({
  method: 'GET',
  url: 'https://pure.app/v2/users/Fixture%20Person/messages/fixture%20private%20message/abc123'
});
assert.equal(adversarialPath.path, '/v2/users/:segment/messages/:segment/:segment');
for (const seed of seeds.slice(2)) {
  assert.equal(decodeURIComponent(adversarialPath.path).includes(seed), false);
}

const listenerShaped = sanitizeProtocolEvent({
  kind: 'http',
  method: 'PATCH',
  host: 'api.pure.app',
  path: '/v2/profiles/98765432109876543210',
  queryKeys: ['token', 'radius'],
  requestHeaderNames: ['X-Trace-ID', 'Authorization', 'Cookie'],
  responseHeaderNames: ['Content-Type', 'Set-Cookie'],
  requestPayload: {
    type: 'object',
    keys: ['profile', 'message'],
    fields: {
      profile: {type: 'object', keys: ['id', 'name'], fields: {id: {type: 'string'}, name: {type: 'string'}}},
      message: {type: 'string', length: 23}
    }
  },
  responseSummary: {
    type: 'object',
    keys: ['ok', 'result'],
    fields: {
      ok: {type: 'boolean', value: true},
      result: {type: 'object', keys: ['code'], fields: {code: {type: 'number', value: 201}}}
    }
  },
  status: 200
});
assert.deepEqual(listenerShaped.requestHeaderNames, ['authorization', 'cookie', 'x-trace-id']);
assert.deepEqual(listenerShaped.responseHeaderNames, ['content-type', 'set-cookie']);
assert.deepEqual(listenerShaped.requestBody.fields.profile.fields.name, {type: 'string'});
assert.deepEqual(listenerShaped.response.body.fields.result.fields.code, {type: 'number'});
assert.doesNotThrow(() => assertFixtureSafe(listenerShaped));

const wideSummary = {
  type: 'object',
  keys: Array.from({length: 40}, (_, index) => `field${index}`),
  fields: Object.fromEntries(Array.from({length: 40}, (_, index) => [`field${index}`, {type: 'string'}]))
};
const oversizedEvents = Array.from({length: 400}, (_, index) => ({
  kind: 'http',
  method: 'POST',
  host: 'api.pure.app',
  path: `/v2/messages/${index + 100000}`,
  requestPayload: wideSummary,
  responseSummary: wideSummary,
  status: 200
}));
const sizeBoundedFixture = buildSafeProtocolFixture(oversizedEvents);
assert.ok(Buffer.byteLength(`${JSON.stringify(sizeBoundedFixture)}\n`, 'utf8') <= PROTOCOL_FIXTURE_MAX_BYTES);
assert.equal(sizeBoundedFixture.truncated, true);
assert.doesNotThrow(() => assertFixtureSafe(sizeBoundedFixture));

const nestedWideSummary = {
  type: 'object',
  keys: Array.from({length: 35}, (_, branch) => `branch${branch}`),
  fields: Object.fromEntries(Array.from({length: 35}, (_, branch) => [
    `branch${branch}`,
    {
      type: 'object',
      keys: Array.from({length: 35}, (_, leaf) => `leaf${leaf}`),
      fields: Object.fromEntries(Array.from({length: 35}, (_, leaf) => [`leaf${leaf}`, {type: 'string'}]))
    }
  ]))
};
const individuallyOversizedEvent = {
  kind: 'http',
  method: 'POST',
  host: 'api.pure.app',
  path: '/v2/messages/100000',
  requestPayload: nestedWideSummary,
  responseSummary: nestedWideSummary,
  status: 200
};
let oversizedSingleFixture;
assert.doesNotThrow(() => {
  oversizedSingleFixture = buildSafeProtocolFixture([individuallyOversizedEvent]);
});
assert.deepEqual(oversizedSingleFixture.events, []);
assert.equal(oversizedSingleFixture.truncated, true);
assert.ok(Buffer.byteLength(`${JSON.stringify(oversizedSingleFixture)}\n`, 'utf8') <= PROTOCOL_FIXTURE_MAX_BYTES);
assert.doesNotThrow(() => assertFixtureSafe(oversizedSingleFixture));

assert.throws(
  () => sanitizeProtocolEvent({method: 'GET', url: 'https://example.com/api/feed'}),
  /host/i
);

console.log('pure protocol fixture sanitization: ok');
