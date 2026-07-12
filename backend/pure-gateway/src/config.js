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
    privateJwk = JSON.parse(values.GATEWAY_PRIVATE_JWK);
  } catch (_) {
    throw configError();
  }
  if (!privateJwk || typeof privateJwk !== 'object' || Array.isArray(privateJwk)) throw configError();
  if (Buffer.byteLength(values.GATEWAY_HMAC_SECRET, 'utf8') < 32) throw configError();

  return Object.freeze({
    controlPlaneUrl,
    gatewayId: values.GATEWAY_ID,
    hmacSecret: values.GATEWAY_HMAC_SECRET,
    privateJwk: Object.freeze({...privateJwk}),
    gatewayKeyId: values.GATEWAY_KEY_ID
  });
}

export {REQUIRED_ENV};
