const ALLOWED_HOSTS = ['pure.app', 'thepure.app'];
const MAX_DEPTH = 5;
const MAX_KEYS = 40;
const MAX_ARRAY_ITEMS = 20;
const MAX_FIXTURE_ITEMS = 400;
export const PROTOCOL_FIXTURE_MAX_BYTES = 64 * 1024;

const STATIC_PATH_SEGMENTS = new Set([
  'api', 'assets', 'auth', 'blocks', 'boosts', 'chat', 'chats', 'cities', 'connection',
  'countries', 'events', 'feed', 'feeds', 'geo', 'like', 'likes', 'location', 'locations',
  'match', 'matches', 'me', 'media', 'message', 'messages', 'moderation', 'notifications',
  'profile', 'profiles', 'reactions', 'search', 'session', 'settings', 'subscriptions',
  'upload', 'user', 'users', 'ws', 'websocket'
]);

const UNSAFE_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+\/-]+=*/i,
  /\b(?:authorization|cookie|set-cookie)\s*[:=]/i,
  /\b(?:access|auth|refresh|session)[_-]?token\s*[:=]/i,
  /[?&](?:token|auth|key|session)=[^&\s]+/i
];

export function sanitizeProtocolEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('Protocol event must be an object');
  }

  const location = normalizeLocation(event);
  const fixture = compact({
    kind: normalizeKind(event.kind),
    method: normalizeMethod(event.method || event.request?.method),
    host: location.host,
    path: generalizePath(location.path),
    queryKeys: location.queryKeys,
    requestHeaderNames: headerNames(event.requestHeaderNames || event.requestHeaders || event.headers || event.request?.headers),
    responseHeaderNames: headerNames(event.responseHeaderNames || event.response?.headers),
    requestBody: event.requestPayload !== undefined ? shapeFromSummary(event.requestPayload) :
      shapeOf(firstDefined(event.requestBody, event.request?.body, event.request?.postData, event.body)),
    response: sanitizeResponse(event.response, event.responseSummary),
    status: normalizeStatus(event.status)
  });

  assertFixtureSafe(fixture);
  return fixture;
}

export function buildSafeProtocolFixture(rawEvents) {
  const source = Array.isArray(rawEvents) ? rawEvents.filter(event => event?.host) : [];
  const fixture = {schemaVersion: 1, events: [], truncated: false};

  for (let index = 0; index < source.length; index += 1) {
    if (fixture.events.length >= MAX_FIXTURE_ITEMS) {
      fixture.truncated = true;
      break;
    }
    let event;
    try {
      event = sanitizeProtocolEvent(source[index]);
    } catch (_) {
      fixture.truncated = true;
      continue;
    }
    const candidate = {
      ...fixture,
      events: [...fixture.events, event],
      truncated: index < source.length - 1
    };
    if (serializedBytes(candidate) + 1 > PROTOCOL_FIXTURE_MAX_BYTES) {
      fixture.truncated = true;
      break;
    }
    fixture.events.push(event);
  }
  fixture.truncated ||= fixture.events.length < source.length;
  assertFixtureSafe(fixture);
  return fixture;
}

export function assertFixtureSafe(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_) {
    throw new Error('Unsafe fixture: value is not JSON serializable');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > PROTOCOL_FIXTURE_MAX_BYTES) {
    throw new Error('Unsafe fixture: size limit exceeded');
  }
  for (const pattern of UNSAFE_VALUE_PATTERNS) {
    if (pattern.test(serialized)) throw new Error('Unsafe fixture: credential-like value detected');
  }
  scanFixture(value, [], 0);
  return value;
}

function normalizeLocation(event) {
  const rawUrl = event.url || event.request?.url;
  if (rawUrl) {
    const url = new URL(String(rawUrl));
    assertAllowedHost(url.hostname);
    return {
      host: url.hostname.toLowerCase(),
      path: url.pathname || '/',
      queryKeys: uniqueSorted([...url.searchParams.keys()].map(normalizeKey))
    };
  }

  const host = String(event.host || '').toLowerCase();
  assertAllowedHost(host);
  return {
    host,
    path: String(event.path || '/').split('?')[0] || '/',
    queryKeys: uniqueSorted((event.queryKeys || []).map(normalizeKey))
  };
}

function assertAllowedHost(host) {
  const allowed = ALLOWED_HOSTS.some(root => host === root || host.endsWith(`.${root}`));
  if (!allowed) throw new Error(`Protocol host is not allowlisted: ${host || '(missing)'}`);
}

function generalizePath(path) {
  const normalized = String(path || '/').startsWith('/') ? String(path || '/') : `/${path}`;
  const segments = normalized.split('/').map(segment => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch (_) {}
    if (!decoded) return decoded;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded)) return ':uuid';
    if (/^\d{6,}$/.test(decoded)) return ':id';
    if (/^[a-f0-9]{16,}$/i.test(decoded)) return ':id';
    if (/^[A-Za-z0-9_-]{24,}$/.test(decoded)) return ':id';
    const lower = decoded.toLowerCase();
    if (/^v\d{1,2}$/.test(lower) || STATIC_PATH_SEGMENTS.has(lower)) return lower;
    return ':segment';
  });
  return segments.join('/') || '/';
}

function normalizeMethod(value) {
  const method = String(value || 'GET').trim().toUpperCase();
  return /^[A-Z]{1,16}$/.test(method) ? method : 'OTHER';
}

function normalizeKind(value) {
  if (typeof value !== 'string') return undefined;
  const kind = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(kind) ? kind : undefined;
}

function normalizeStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function normalizeKey(value) {
  return sanitizeFieldKey(String(value).trim().toLowerCase());
}

function headerNames(headers) {
  if (Array.isArray(headers)) return uniqueSorted(headers.slice(0, MAX_KEYS).map(normalizeKey));
  if (!headers || typeof headers !== 'object') return undefined;
  return uniqueSorted(Object.keys(headers).slice(0, MAX_KEYS).map(normalizeKey));
}

function uniqueSorted(values) {
  const result = [...new Set(values.filter(Boolean))].sort();
  return result.length ? result.slice(0, MAX_KEYS) : undefined;
}

function sanitizeResponse(response, responseSummary) {
  if (responseSummary !== undefined) {
    return compact({status: normalizeStatus(response?.status), body: shapeFromSummary(responseSummary)});
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined;
  return compact({
    status: normalizeStatus(response.status),
    body: shapeOf(firstDefined(response.body, response.data))
  });
}

function shapeFromSummary(summary, depth = 0) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return shapeOf(summary, depth);
  const type = typeof summary.type === 'string' ? summary.type : undefined;
  if (!['array', 'boolean', 'null', 'number', 'object', 'string', 'undefined'].includes(type)) {
    return shapeOf(summary, depth);
  }
  if (type === 'array') {
    const sampleType = summary.sample?.type;
    return compact({
      type: 'array',
      itemTypes: typeof sampleType === 'string' ? uniqueSorted([sampleType]) : undefined
    });
  }
  if (type !== 'object') return {type};

  const rawKeys = Array.isArray(summary.keys) ? summary.keys.slice(0, MAX_KEYS).map(String) :
    Object.keys(summary.fields || {}).slice(0, MAX_KEYS);
  const keys = rawKeys.map(sanitizeFieldKey);
  const fields = {};
  if (depth < MAX_DEPTH) {
    for (let index = 0; index < rawKeys.length; index += 1) {
      const child = summary.fields?.[rawKeys[index]];
      if (child !== undefined) fields[keys[index]] = shapeFromSummary(child, depth + 1);
    }
  }
  return compact({type: 'object', keys: uniqueSorted(keys), fields: depth < MAX_DEPTH ? fields : undefined});
}

function shapeOf(value, depth = 0) {
  if (value === undefined) return undefined;
  if (value === null) return {type: 'null'};
  if (Array.isArray(value)) {
    const itemTypes = uniqueSorted(value.slice(0, MAX_ARRAY_ITEMS).map(item => typeName(item)));
    return compact({type: 'array', itemTypes});
  }
  if (typeof value === 'object') {
    const rawKeys = Object.keys(value).sort().slice(0, MAX_KEYS);
    const keys = rawKeys.map(sanitizeFieldKey);
    const fields = {};
    if (depth < MAX_DEPTH) {
      for (let index = 0; index < rawKeys.length; index += 1) {
        fields[keys[index]] = shapeOf(value[rawKeys[index]], depth + 1);
      }
    }
    return compact({
      type: 'object',
      keys: uniqueSorted(keys),
      fields: depth < MAX_DEPTH ? fields : undefined,
      truncated: Object.keys(value).length > MAX_KEYS || undefined
    });
  }
  return {type: typeName(value)};
}

function sanitizeFieldKey(value) {
  const key = String(value).slice(0, 80);
  if (/^\d{6,}$/.test(key) || /^[a-f0-9]{16,}$/i.test(key)) return ':id';
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,79}$/.test(key)) return ':key';
  return key;
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function firstDefined(...values) {
  return values.find(value => value !== undefined);
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function compact(value) {
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    if (Array.isArray(child) && child.length === 0) continue;
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) continue;
    result[key] = child;
  }
  return result;
}

function scanFixture(value, path, depth) {
  if (depth > MAX_DEPTH * 2 + 8) throw new Error('Unsafe fixture: depth limit exceeded');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (value.length > 160) throw new Error('Unsafe fixture: string limit exceeded');
    const key = String(path.at(-1) || '');
    if (/(authorization|cookie|token|secret|session|password|name|message|text|id)$/i.test(key) && key !== 'type') {
      throw new Error('Unsafe fixture: sensitive scalar field detected');
    }
    if (!isAllowedFixtureString(path, value)) throw new Error('Unsafe fixture: unexpected string value');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_FIXTURE_ITEMS) throw new Error('Unsafe fixture: array limit exceeded');
    for (const child of value) scanFixture(child, path.concat('[]'), depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') throw new Error('Unsafe fixture: unsupported value type');
  const entries = Object.entries(value);
  if (entries.length > MAX_KEYS) throw new Error('Unsafe fixture: key limit exceeded');
  for (const [key, child] of entries) scanFixture(child, path.concat(key), depth + 1);
}

function isAllowedFixtureString(path, value) {
  const key = String(path.at(-1) || '');
  if (key === 'kind') return /^[a-z][a-z0-9_-]{0,31}$/.test(value);
  if (key === 'method') return /^[A-Z]{1,16}$/.test(value);
  if (key === 'host') return ALLOWED_HOSTS.some(root => value === root || value.endsWith(`.${root}`));
  if (key === 'path') return value.startsWith('/') && !/[?#]/.test(value);
  if (key === 'type' || (key === '[]' && path.at(-2) === 'itemTypes')) {
    return ['array', 'bigint', 'boolean', 'function', 'null', 'number', 'object', 'string', 'symbol', 'undefined'].includes(value);
  }
  if (key === '[]' && ['keys', 'queryKeys', 'requestHeaderNames', 'responseHeaderNames'].includes(path.at(-2))) {
    return /^:[a-z]+$|^[A-Za-z_][A-Za-z0-9_.:-]{0,79}$/.test(value);
  }
  return false;
}
