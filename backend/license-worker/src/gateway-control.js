const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};
const ROUTES = new Set(['/internal/gateway/leases', '/internal/gateway/heartbeat']);
const HEARTBEAT_STATES = new Set([
  'disabled',
  'decrypting',
  'authenticating',
  'compatibility_required',
  'revoked'
]);
const MAX_CLOCK_SKEW_SECONDS = 30;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_LEASES = 20;
const LEASE_MILLISECONDS = 60 * 1000;
const encoder = new TextEncoder();

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {status, headers: JSON_HEADERS});
}

function errorResponse(code, status) {
  return json({ok: false, code}, status);
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function secrets(env) {
  const configured = Object.create(null);
  try {
    const parsed = JSON.parse(String(env.GATEWAY_HMAC_SECRETS || '{}'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return configured;
    for (const [gatewayId, secret] of Object.entries(parsed)) {
      if (/^[A-Za-z0-9_-]{1,80}$/.test(gatewayId) && typeof secret === 'string' && encoder.encode(secret).byteLength >= 32) {
        configured[gatewayId] = secret;
      }
    }
  } catch (_) {}
  return configured;
}

function constantTimeHexEqual(left, right) {
  const a = encoder.encode(String(left || ''));
  const b = encoder.encode(String(right || ''));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

async function readBody(request) {
  const declared = request.headers.get('content-length');
  if (/^\d+$/.test(declared || '') && Number(declared) > MAX_REQUEST_BYTES) throw new Error('INVALID_REQUEST');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new Error('INVALID_REQUEST');
  return bytes;
}

async function expectedSignature(secret, canonical) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign']
  );
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical))));
}

async function authenticate(request, env, url, bodyBytes, now) {
  const gatewayId = request.headers.get('x-gateway-id') || '';
  const timestampText = request.headers.get('x-gateway-timestamp') || '';
  const nonce = request.headers.get('x-gateway-nonce') || '';
  const suppliedSignature = request.headers.get('x-gateway-signature') || '';
  const secret = secrets(env)[gatewayId];
  const timestamp = Number(timestampText);
  if (
    !secret ||
    !/^\d{10}$/.test(timestampText) ||
    !Number.isSafeInteger(timestamp) ||
    Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > MAX_CLOCK_SKEW_SECONDS ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(suppliedSignature)
  ) {
    return {error: errorResponse('GATEWAY_UNAUTHORIZED', 401)};
  }

  const digest = await sha256(bodyBytes);
  const path = `${url.pathname}${url.search}`;
  const canonical = [request.method.toUpperCase(), path, timestampText, nonce, digest].join('\n');
  const expected = await expectedSignature(secret, canonical);
  if (!constantTimeHexEqual(suppliedSignature, expected)) {
    return {error: errorResponse('GATEWAY_UNAUTHORIZED', 401)};
  }

  const nonceHash = await sha256(encoder.encode(`${gatewayId}\n${nonce}`));
  const nowIso = now.toISOString();
  await env.DB.prepare(`
    DELETE FROM bridge_gateway_nonces
    WHERE expires_at <= ?
  `).bind(nowIso).run();
  const inserted = await env.DB.prepare(`
    INSERT INTO bridge_gateway_nonces (gateway_id, nonce_hash, signed_at, expires_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+5 minutes'))
    ON CONFLICT(gateway_id, nonce_hash) DO NOTHING
  `).bind(gatewayId, nonceHash, nowIso, nowIso).run();
  if (inserted?.meta?.changes !== 1) return {error: errorResponse('GATEWAY_REPLAY', 409)};
  return {gatewayId};
}

function parseBody(bytes) {
  try {
    if (!bytes.byteLength) throw new Error();
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch (_) {
    return null;
  }
}

function exactKeys(value, allowed) {
  return value && !Array.isArray(value) && typeof value === 'object' &&
    Object.keys(value).every(key => allowed.includes(key));
}

async function acquireLeases(env, gatewayId, requestedLimit, now, randomUUID) {
  const limit = Math.max(1, Math.min(Number.isSafeInteger(requestedLimit) ? requestedLimit : MAX_LEASES, MAX_LEASES));
  const candidates = await env.DB.prepare(`
    SELECT
      s.id,
      s.account_id,
      s.active_device_id,
      s.envelope_ciphertext,
      s.status,
      a.status AS account_status,
      d.status AS device_status
    FROM bridge_cloud_sessions s
    JOIN bridge_accounts a ON a.id = s.account_id AND a.status = 'active'
    JOIN bridge_devices d ON d.account_id = s.account_id AND d.id = s.active_device_id AND d.status = 'active'
    WHERE s.status IN ('pending', 'active')
      AND s.revoked_at IS NULL
    ORDER BY s.created_at, s.account_id
    LIMIT ?
  `).bind(limit).all();

  const leases = [];
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + LEASE_MILLISECONDS).toISOString();
  for (const candidate of candidates?.results || []) {
    const leaseId = `lease_${randomUUID()}`;
    const leaseTokenHash = await sha256(encoder.encode(`${leaseId}\n${gatewayId}\n${randomUUID()}`));
    const acquired = await env.DB.prepare(`
      INSERT INTO bridge_gateway_leases (
        id, account_id, device_id, gateway_id, lease_token_hash,
        lease_seconds, acquired_at, expires_at, released_at
      )
      SELECT ?, ?, ?, ?, ?, 60, ?, ?, NULL
      WHERE EXISTS (
        SELECT 1
        FROM bridge_cloud_sessions s
        JOIN bridge_accounts a ON a.id = s.account_id AND a.status = 'active'
        JOIN bridge_devices d ON d.account_id = s.account_id AND d.id = s.active_device_id AND d.status = 'active'
        WHERE s.account_id = ? AND s.active_device_id = ?
          AND s.status IN ('pending', 'active') AND s.revoked_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM bridge_gateway_leases current
        WHERE current.account_id = ? AND current.released_at IS NULL AND current.expires_at > ?
      )
    `).bind(
      leaseId,
      candidate.account_id,
      candidate.active_device_id,
      gatewayId,
      leaseTokenHash,
      nowIso,
      expiresAt,
      candidate.account_id,
      candidate.active_device_id,
      candidate.account_id,
      nowIso
    ).run();
    if (acquired?.meta?.changes !== 1) continue;

    let envelope;
    try {
      envelope = JSON.parse(String(candidate.envelope_ciphertext || ''));
    } catch (_) {
      await env.DB.prepare(`UPDATE bridge_gateway_leases SET released_at = ? WHERE id = ?`)
        .bind(nowIso, leaseId).run();
      continue;
    }
    const lease = {
      account_id: String(candidate.account_id),
      state: String(candidate.status),
      lease_expires_at: expiresAt,
      envelope
    };
    const proposed = {ok: true, leases: [...leases, lease]};
    if (encoder.encode(JSON.stringify(proposed)).byteLength > MAX_RESPONSE_BYTES) {
      await env.DB.prepare(`UPDATE bridge_gateway_leases SET released_at = ? WHERE id = ?`)
        .bind(nowIso, leaseId).run();
      break;
    }
    leases.push(lease);
  }
  return json({ok: true, leases});
}

async function heartbeat(env, gatewayId, connectors, now) {
  if (!Array.isArray(connectors) || connectors.length > MAX_LEASES) {
    return errorResponse('GATEWAY_INVALID_HEARTBEAT', 400);
  }
  const nowIso = now.toISOString();
  let accepted = 0;
  for (const connector of connectors) {
    if (
      !exactKeys(connector, ['account_id', 'state']) ||
      typeof connector.account_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(connector.account_id) ||
      !HEARTBEAT_STATES.has(connector.state)
    ) {
      return errorResponse('GATEWAY_INVALID_HEARTBEAT', 400);
    }
    const updated = await env.DB.prepare(`
      UPDATE bridge_gateway_leases
      SET connector_state = ?, heartbeat_at = ?
      WHERE account_id = ? AND gateway_id = ?
        AND released_at IS NULL AND expires_at > ?
    `).bind(connector.state, nowIso, connector.account_id, gatewayId, nowIso).run();
    if (updated?.meta?.changes !== 1) return errorResponse('GATEWAY_INVALID_HEARTBEAT', 400);
    accepted += 1;
  }
  return json({ok: true, accepted});
}

export function createGatewayControl(options = {}) {
  const now = options.now || (() => new Date());
  const randomUUID = options.randomUUID || (() => crypto.randomUUID());

  return Object.freeze({
    async handle(request, env) {
      const url = new URL(request.url);
      if (!ROUTES.has(url.pathname)) return null;
      if (request.method !== 'POST') return errorResponse('GATEWAY_NOT_FOUND', 404);
      if (!env.DB) return errorResponse('GATEWAY_UNAVAILABLE', 503);
      try {
        let bodyBytes;
        try {
          bodyBytes = await readBody(request);
        } catch (_) {
          return errorResponse('GATEWAY_INVALID_REQUEST', 400);
        }
        const current = now();
        const auth = await authenticate(request, env, url, bodyBytes, current);
        if (auth.error) return auth.error;
        const body = parseBody(bodyBytes);
        if (!exactKeys(body, url.pathname.endsWith('/leases') ? ['gateway_id', 'limit'] : ['gateway_id', 'connectors'])) {
          return errorResponse('GATEWAY_INVALID_REQUEST', 400);
        }
        if (body.gateway_id !== auth.gatewayId) return errorResponse('GATEWAY_UNAUTHORIZED', 401);
        if (url.pathname.endsWith('/leases')) {
          if (!Number.isSafeInteger(body.limit) || body.limit < 1) return errorResponse('GATEWAY_INVALID_REQUEST', 400);
          return acquireLeases(env, auth.gatewayId, body.limit, current, randomUUID);
        }
        return heartbeat(env, auth.gatewayId, body.connectors, current);
      } catch (_) {
        return errorResponse('GATEWAY_UNAVAILABLE', 503);
      }
    }
  });
}
