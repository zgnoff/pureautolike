(() => {
  'use strict';

  const VERSION = 1;
  const HKDF_INFO = 'pureautolike/cloud-session-envelope/v1';
  const encoder = new TextEncoder();

  function requireString(value, name) {
    if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
    return value;
  }

  function publicP256Jwk(value) {
    const coordinatePattern = /^[A-Za-z0-9_-]{43}$/;
    if (!value || value.kty !== 'EC' || value.crv !== 'P-256') {
      throw new TypeError('gatewayPublicKey must be an EC P-256 public JWK');
    }
    requireString(value.x, 'gatewayPublicKey.x');
    requireString(value.y, 'gatewayPublicKey.y');
    if (!coordinatePattern.test(value.x) || !coordinatePattern.test(value.y)) {
      throw new TypeError('gatewayPublicKey must contain P-256 coordinates');
    }
    if (value.d !== undefined) throw new TypeError('gatewayPublicKey must not contain private key material');
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
    const gatewayPublicKey = publicP256Jwk(input.gatewayPublicKey);
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

  globalThis.PalCloudEnvelope = Object.freeze({encryptSession});
})();
