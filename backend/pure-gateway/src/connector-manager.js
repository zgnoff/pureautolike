import {decryptSessionEnvelope} from './crypto.js';

export const CONNECTOR_STATES = Object.freeze([
  'disabled',
  'decrypting',
  'authenticating',
  'compatibility_required',
  'revoked'
]);

const STATE_SET = new Set(CONNECTOR_STATES);

export class ConnectorManager {
  #connectors = new Map();
  #privateJwk;
  #keyId;
  #decrypt;
  #onTransition;

  constructor(options = {}) {
    this.#privateJwk = options.privateJwk;
    this.#keyId = options.keyId;
    this.#decrypt = options.decrypt || decryptSessionEnvelope;
    this.#onTransition = typeof options.onTransition === 'function' ? options.onTransition : () => {};
  }

  #transition(accountId, state, envelope = null) {
    if (!STATE_SET.has(state)) throw new TypeError('Invalid connector state');
    const existing = this.#connectors.get(accountId) || {};
    const connector = {
      accountId,
      state,
      envelopeVersion: envelope ? `${envelope.keyId || ''}:${envelope.createdAt || ''}` : existing.envelopeVersion || ''
    };
    this.#connectors.set(accountId, connector);
    this.#onTransition(Object.freeze({account_id: accountId, state}));
  }

  snapshot() {
    return [...this.#connectors.values()]
      .map(connector => ({account_id: connector.accountId, state: connector.state}))
      .sort((left, right) => left.account_id.localeCompare(right.account_id));
  }

  async reconcile(leases = []) {
    if (!Array.isArray(leases)) throw new TypeError('leases must be an array');
    const present = new Set();
    for (const lease of leases) {
      const accountId = typeof lease?.account_id === 'string' ? lease.account_id : '';
      if (!accountId) continue;
      present.add(accountId);
      if (lease.revoked === true || lease.state === 'revoked') {
        this.#transition(accountId, 'revoked');
        continue;
      }
      if (lease.disabled === true || lease.state === 'disabled') {
        this.#transition(accountId, 'disabled');
        continue;
      }
      const envelopeVersion = `${lease.envelope?.keyId || ''}:${lease.envelope?.createdAt || ''}`;
      const existing = this.#connectors.get(accountId);
      if (existing?.envelopeVersion === envelopeVersion && existing.state === 'compatibility_required') continue;

      this.#transition(accountId, 'decrypting', lease.envelope);
      let session;
      try {
        session = await this.#decrypt(lease.envelope, {
          privateJwk: this.#privateJwk,
          keyId: this.#keyId,
          accountBinding: accountId
        });
        this.#transition(accountId, 'authenticating', lease.envelope);
        // The Pure adapter is deliberately absent until sanitized real fixtures exist.
        this.#transition(accountId, 'compatibility_required', lease.envelope);
      } catch (_) {
        this.#transition(accountId, 'compatibility_required', lease.envelope);
      } finally {
        if (session) {
          session.bearer = '';
          session.xJsUserAgent = '';
          session = null;
        }
      }
    }
    for (const connector of this.#connectors.values()) {
      if (present.has(connector.accountId)) continue;
      if (connector.state !== 'disabled') this.#transition(connector.accountId, 'disabled');
      this.#connectors.delete(connector.accountId);
    }
    return this.snapshot();
  }
}
