const REQUIRED_ENV = Object.freeze([
  'CONTROL_PLANE_URL',
  'GATEWAY_ID',
  'GATEWAY_HMAC_SECRET',
  'GATEWAY_PRIVATE_JWK',
  'GATEWAY_KEY_ID'
]);

function configError() {
  const error = new Error('Gateway configuration is invalid');
  error.code = 'INVALID_CONFIG';
  return error;
}

function requiredString(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw configError();
  return value.trim();
}

function canonicalCoordinate(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.byteLength === 32 && bytes.toString('base64url') === value;
}

function validatePrivateJwk(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw configError();
  const allowed = new Set(['kty', 'crv', 'x', 'y', 'd', 'ext', 'key_ops']);
  const required = ['kty', 'crv', 'x', 'y', 'd'];
  if (
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key)) ||
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    value.kty !== 'EC' ||
    value.crv !== 'P-256' ||
    !canonicalCoordinate(value.x) ||
    !canonicalCoordinate(value.y) ||
    !canonicalCoordinate(value.d) ||
    (Object.prototype.hasOwnProperty.call(value, 'ext') && value.ext !== true) ||
    (Object.prototype.hasOwnProperty.call(value, 'key_ops') && (
      !Array.isArray(value.key_ops) ||
      value.key_ops.length !== 1 ||
      value.key_ops[0] !== 'deriveBits'
    ))
  ) throw configError();

  const validated = {kty: 'EC', crv: 'P-256', x: value.x, y: value.y, d: value.d};
  if (Object.prototype.hasOwnProperty.call(value, 'ext')) validated.ext = true;
  if (Object.prototype.hasOwnProperty.call(value, 'key_ops')) validated.key_ops = Object.freeze(['deriveBits']);
  return Object.freeze(validated);
}

export function loadConfig(env = process.env) {
  const values = Object.fromEntries(REQUIRED_ENV.map(name => [name, requiredString(env, name)]));
  let controlPlaneUrl;
  let privateJwk;
  try {
    const parsedUrl = new URL(values.CONTROL_PLANE_URL);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      throw configError();
    }
    controlPlaneUrl = parsedUrl.href.replace(/\/$/, '');
    privateJwk = validatePrivateJwk(JSON.parse(values.GATEWAY_PRIVATE_JWK));
  } catch (_) {
    throw configError();
  }
  if (Buffer.byteLength(values.GATEWAY_HMAC_SECRET, 'utf8') < 32) throw configError();

  return Object.freeze({
    controlPlaneUrl,
    gatewayId: values.GATEWAY_ID,
    hmacSecret: values.GATEWAY_HMAC_SECRET,
    privateJwk,
    gatewayKeyId: values.GATEWAY_KEY_ID
  });
}

export {REQUIRED_ENV};
