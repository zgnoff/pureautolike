import {toolError} from './errors.js';

function validIdentity(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort()) output[key] = stable(value[key]);
    return output;
  }
  return value;
}

export function confirmationBinding({callerId, accountId, operation, schemaVersion, args}) {
  return JSON.stringify(stable({callerId, accountId, operation, schemaVersion, args}));
}

export async function authorize(definition, args, context = {}, confirmationVerifier) {
  const scopes = Array.isArray(context.scopes) ? new Set(context.scopes) : new Set();
  if (!validIdentity(context.callerId) || !validIdentity(context.accountId)) {
    throw toolError('permission_denied');
  }
  if (!definition.scopes.every(scope => scopes.has(scope))) throw toolError('permission_denied');
  if (definition.confirmation !== 'dangerous') return;
  if (typeof context.confirmationToken !== 'string' || typeof confirmationVerifier !== 'function') {
    throw toolError('confirmation_required');
  }
  const binding = confirmationBinding({
    callerId: context.callerId,
    accountId: context.accountId,
    operation: definition.name,
    schemaVersion: definition.schemaVersion,
    args
  });
  let valid = false;
  try {
    valid = await confirmationVerifier({token: context.confirmationToken, binding});
  } catch (_) {}
  if (valid !== true) throw toolError('confirmation_required');
}
