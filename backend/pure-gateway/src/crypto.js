import {webcrypto} from 'node:crypto';

const {subtle} = webcrypto;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const HKDF_INFO = encoder.encode('pureautolike/cloud-session-envelope/v1');
const MAX_CIPHERTEXT_BYTES = 64 * 1024;

export class GatewayCryptoError extends Error {
  constructor(code) {
    super(code === 'KEY_MISMATCH'
      ? 'Gateway key does not match the envelope'
      : code === 'ACCOUNT_MISMATCH'
        ? 'Account does not match the envelope'
        : code === 'INVALID_ENVELOPE'
          ? 'Session envelope is invalid'
          : 'Session envelope could not be decrypted');
    this.name = 'GatewayCryptoError';
    this.code = code;
  }
}

function fail(code) {
  throw new GatewayCryptoError(code);
}

function canonicalBase64Url(value, expectedLength = null, maximumLength = null) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail('INVALID_ENVELOPE');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail('INVALID_ENVELOPE');
  if (expectedLength !== null && bytes.byteLength !== expectedLength) fail('INVALID_ENVELOPE');
  if (maximumLength !== null && bytes.byteLength > maximumLength) fail('INVALID_ENVELOPE');
  return bytes;
}

function validateEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ENVELOPE');
  const allowed = new Set([
    'version', 'keyId', 'accountBinding', 'createdAt', 'ephemeralPublicKey', 'salt', 'iv', 'ciphertext'
  ]);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key))) fail('INVALID_ENVELOPE');
  if (
    value.version !== 1 ||
    typeof value.keyId !== 'string' || !value.keyId ||
    typeof value.accountBinding !== 'string' || !value.accountBinding ||
    !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0
  ) fail('INVALID_ENVELOPE');
  const publicKey = value.ephemeralPublicKey;
  if (!publicKey || typeof publicKey !== 'object' || Array.isArray(publicKey)) fail('INVALID_ENVELOPE');
  if (
    Reflect.ownKeys(publicKey).some(key => !['kty', 'crv', 'x', 'y'].includes(key)) ||
    publicKey.kty !== 'EC' || publicKey.crv !== 'P-256'
  ) fail('INVALID_ENVELOPE');
  canonicalBase64Url(publicKey.x, 32).fill(0);
  canonicalBase64Url(publicKey.y, 32).fill(0);
}

function validateSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) fail('DECRYPT_FAILED');
  const keys = Reflect.ownKeys(session);
  if (keys.length !== 2 || !keys.includes('bearer') || !keys.includes('xJsUserAgent')) fail('DECRYPT_FAILED');
  if (
    typeof session.bearer !== 'string' || !session.bearer ||
    typeof session.xJsUserAgent !== 'string' || !session.xJsUserAgent
  ) fail('DECRYPT_FAILED');
  return session;
}

export async function decryptSessionEnvelope(envelope, options = {}) {
  let salt;
  let iv;
  let ciphertext;
  let sharedSecret;
  let aad;
  let plaintext;
  let decoded = '';
  try {
    validateEnvelope(envelope);
    if (typeof options.keyId !== 'string' || envelope.keyId !== options.keyId) fail('KEY_MISMATCH');
    if (typeof options.accountBinding !== 'string' || envelope.accountBinding !== options.accountBinding) {
      fail('ACCOUNT_MISMATCH');
    }
    if (!options.privateJwk || typeof options.privateJwk !== 'object') fail('DECRYPT_FAILED');

    salt = canonicalBase64Url(envelope.salt, 32);
    iv = canonicalBase64Url(envelope.iv, 12);
    ciphertext = canonicalBase64Url(envelope.ciphertext, null, MAX_CIPHERTEXT_BYTES);
    if (ciphertext.byteLength < 16) fail('INVALID_ENVELOPE');
    const privateKey = await subtle.importKey(
      'jwk',
      options.privateJwk,
      {name: 'ECDH', namedCurve: 'P-256'},
      false,
      ['deriveBits']
    );
    const ephemeralKey = await subtle.importKey(
      'jwk',
      envelope.ephemeralPublicKey,
      {name: 'ECDH', namedCurve: 'P-256'},
      false,
      []
    );
    sharedSecret = new Uint8Array(await subtle.deriveBits(
      {name: 'ECDH', public: ephemeralKey},
      privateKey,
      256
    ));
    const hkdfKey = await subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
    const aesKey = await subtle.deriveKey(
      {name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO},
      hkdfKey,
      {name: 'AES-GCM', length: 256},
      false,
      ['decrypt']
    );
    aad = encoder.encode(JSON.stringify({
      version: envelope.version,
      keyId: envelope.keyId,
      accountBinding: envelope.accountBinding,
      createdAt: envelope.createdAt
    }));
    plaintext = new Uint8Array(await subtle.decrypt(
      {name: 'AES-GCM', iv, additionalData: aad, tagLength: 128},
      aesKey,
      ciphertext
    ));
    decoded = decoder.decode(plaintext);
    return validateSession(JSON.parse(decoded));
  } catch (error) {
    if (error instanceof GatewayCryptoError) throw error;
    fail('DECRYPT_FAILED');
  } finally {
    salt?.fill(0);
    iv?.fill(0);
    ciphertext?.fill(0);
    sharedSecret?.fill(0);
    aad?.fill(0);
    plaintext?.fill(0);
    decoded = '';
  }
}
