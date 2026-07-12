(() => {
  'use strict';

  const VERSION = 1;
  const HKDF_INFO = 'pureautolike/cloud-session-envelope/v1';
  const encoder = new TextEncoder();

  function requireString(value, name) {
    if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
    return value;
  }

  function base64Url(bytes) {
    let binary = '';
    const view = new Uint8Array(bytes);
    for (let offset = 0; offset < view.length; offset += 0x8000) {
      binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decodeCanonicalCoordinate(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    try {
      const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      if (bytes.byteLength !== 32 || base64Url(bytes) !== value) return null;
      return bytes;
    } catch (_) {
      return null;
    }
  }

  function validateGatewayPublicKey(value) {
    const allowed = new Set(['kty', 'crv', 'x', 'y', 'ext', 'key_ops']);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Gateway public key must be an EC P-256 public JWK');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'd')) {
      throw new TypeError('Gateway public key must not contain private key material');
    }
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key))) {
      throw new TypeError('Gateway public key contains unsupported members');
    }
    if (!['kty', 'crv', 'x', 'y'].every(key => Object.prototype.hasOwnProperty.call(value, key))) {
      throw new TypeError('Gateway public key must define all public P-256 members');
    }
    if (value.kty !== 'EC' || value.crv !== 'P-256') {
      throw new TypeError('Gateway public key must be an EC P-256 public JWK');
    }
    if (!decodeCanonicalCoordinate(value.x) || !decodeCanonicalCoordinate(value.y)) {
      throw new TypeError('Gateway public key must contain canonical 32-byte P-256 coordinates');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'ext') && value.ext !== true) {
      throw new TypeError('Gateway public key ext must be true when present');
    }
    if (
      Object.prototype.hasOwnProperty.call(value, 'key_ops') &&
      (!Array.isArray(value.key_ops) || value.key_ops.length !== 0)
    ) {
      throw new TypeError('Gateway public key key_ops must be empty when present');
    }
    const validated = {kty: 'EC', crv: 'P-256', x: value.x, y: value.y};
    if (Object.prototype.hasOwnProperty.call(value, 'ext')) validated.ext = true;
    if (Object.prototype.hasOwnProperty.call(value, 'key_ops')) validated.key_ops = [];
    return validated;
  }

  function aadFor(envelope) {
    return encoder.encode(JSON.stringify({
      version: envelope.version,
      keyId: envelope.keyId,
      accountBinding: envelope.accountBinding,
      createdAt: envelope.createdAt
    }));
  }

  async function encryptSession(options) {
    const input = options || {};
    const gatewayPublicKey = validateGatewayPublicKey(input.gatewayPublicKey);
    const envelope = {
      version: VERSION,
      keyId: requireString(input.keyId, 'keyId'),
      accountBinding: requireString(input.accountBinding, 'accountBinding'),
      createdAt: input.createdAt
    };
    if (!Number.isSafeInteger(envelope.createdAt) || envelope.createdAt <= 0) {
      throw new TypeError('createdAt must be a positive integer timestamp');
    }
    if (!input.session || typeof input.session !== 'object' || Array.isArray(input.session)) {
      throw new TypeError('session must be an object');
    }

    const gatewayKey = await crypto.subtle.importKey(
      'jwk',
      gatewayPublicKey,
      {name: 'ECDH', namedCurve: 'P-256'},
      false,
      []
    );
    const ephemeralKeys = await crypto.subtle.generateKey(
      {name: 'ECDH', namedCurve: 'P-256'},
      true,
      ['deriveBits']
    );
    const sharedSecret = await crypto.subtle.deriveBits(
      {name: 'ECDH', public: gatewayKey},
      ephemeralKeys.privateKey,
      256
    );
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
    const aesKey = await crypto.subtle.deriveKey(
      {name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(HKDF_INFO)},
      hkdfKey,
      {name: 'AES-GCM', length: 256},
      false,
      ['encrypt']
    );
    const ciphertext = await crypto.subtle.encrypt(
      {name: 'AES-GCM', iv, additionalData: aadFor(envelope), tagLength: 128},
      aesKey,
      encoder.encode(JSON.stringify(input.session))
    );
    const ephemeralPublicKey = await crypto.subtle.exportKey('jwk', ephemeralKeys.publicKey);

    return {
      ...envelope,
      ephemeralPublicKey: {
        kty: ephemeralPublicKey.kty,
        crv: ephemeralPublicKey.crv,
        x: ephemeralPublicKey.x,
        y: ephemeralPublicKey.y
      },
      salt: base64Url(salt),
      iv: base64Url(iv),
      ciphertext: base64Url(ciphertext)
    };
  }

  globalThis.PalCloudEnvelope = Object.freeze({encryptSession, validateGatewayPublicKey});
})();
