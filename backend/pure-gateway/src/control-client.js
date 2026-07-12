import {createHash, createHmac, randomBytes} from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_LEASES = 20;
const CONNECTOR_STATES = new Set([
  'disabled',
  'decrypting',
  'authenticating',
  'compatibility_required',
  'revoked'
]);

class ControlClientError extends Error {
  constructor(code, status = null) {
    super(status === null ? code : `${code} (${status})`);
    this.name = 'ControlClientError';
    this.code = code;
    if (status !== null) this.status = status;
  }
}

export function canonicalRequest({method, path, timestamp, nonce, body}) {
  const bodyDigest = createHash('sha256').update(body).digest('hex');
  return [method.toUpperCase(), path, String(timestamp), nonce, bodyDigest].join('\n');
}

export function signRequest(secret, request) {
  return createHmac('sha256', secret).update(canonicalRequest(request)).digest('hex');
}

async function readBounded(response, maximumBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new ControlClientError('CONTROL_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new ControlClientError('CONTROL_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch (_) {
    throw new ControlClientError('CONTROL_INVALID_RESPONSE');
  } finally {
    bytes.fill(0);
  }
}

export function createControlClient(options = {}) {
  let baseUrl;
  try {
    baseUrl = new URL(options.controlPlaneUrl);
  } catch (_) {
    throw new ControlClientError('CONTROL_INVALID_CONFIG');
  }
  const gatewayId = String(options.gatewayId || '');
  const hmacSecret = String(options.hmacSecret || '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Math.max(1, Math.min(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 60_000));
  const maxResponseBytes = Math.max(1, Math.min(
    Number(options.maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES
  ));
  if (!['http:', 'https:'].includes(baseUrl.protocol) || !gatewayId || !hmacSecret || typeof fetchImpl !== 'function') {
    throw new ControlClientError('CONTROL_INVALID_CONFIG');
  }

  async function request(path, payload) {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new ControlClientError('CONTROL_REQUEST_TOO_LARGE');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(24).toString('base64url');
    const signingInput = {method: 'POST', path, timestamp, nonce, body};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, `${baseUrl.href.replace(/\/$/, '')}/`).href, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gateway-id': gatewayId,
          'x-gateway-timestamp': timestamp,
          'x-gateway-nonce': nonce,
          'x-gateway-signature': signRequest(hmacSecret, signingInput)
        },
        body,
        redirect: 'error',
        signal: controller.signal
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ControlClientError('CONTROL_HTTP_ERROR', response.status);
      }
      return parseJson(await readBounded(response, maxResponseBytes));
    } catch (error) {
      if (controller.signal.aborted) throw new ControlClientError('CONTROL_TIMEOUT');
      if (error instanceof ControlClientError) throw error;
      throw new ControlClientError('CONTROL_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async pollLeases({limit = MAX_LEASES} = {}) {
      const boundedLimit = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : MAX_LEASES, MAX_LEASES));
      const response = await request('/internal/gateway/leases', {gateway_id: gatewayId, limit: boundedLimit});
      if (!response || !Array.isArray(response.leases) || response.leases.length > MAX_LEASES) {
        throw new ControlClientError('CONTROL_INVALID_RESPONSE');
      }
      return response.leases;
    },

    async heartbeat(connectors = []) {
      if (!Array.isArray(connectors) || connectors.length > MAX_LEASES) {
        throw new ControlClientError('CONTROL_INVALID_HEARTBEAT');
      }
      const redacted = connectors.map(connector => {
        const accountId = typeof connector?.account_id === 'string' ? connector.account_id : '';
        const state = connector?.state;
        if (!accountId || !CONNECTOR_STATES.has(state)) throw new ControlClientError('CONTROL_INVALID_HEARTBEAT');
        return {account_id: accountId, state};
      });
      return request('/internal/gateway/heartbeat', {gateway_id: gatewayId, connectors: redacted});
    }
  });
}
