import {toolError} from './errors.js';

function validIdentity(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128;
}

function canonical(value) {
  if (value === null) return ['null'];
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'string') return ['string', value];
  if (typeof value === 'number') {
    return ['number', Object.is(value, -0) ? '-0' : String(value)];
  }
  if (Array.isArray(value)) return ['array', value.map(canonical)];
  return ['object', Object.keys(value).sort().map(key => [canonical(key), canonical(value[key])])];
}

function ownData(descriptors, key) {
  const descriptor = descriptors[key];
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
  return descriptor;
}

function snapshotScopes(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(descriptors).length > 0) return null;
  const lengthDescriptor = ownData(descriptors, 'length');
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 256) return null;
  if (Object.keys(descriptors).length !== length + 1) return null;
  const scopes = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = ownData(descriptors, String(index));
    if (!descriptor?.enumerable || typeof descriptor.value !== 'string') return null;
    scopes.push(descriptor.value);
  }
  return scopes;
}

function snapshotContext(context) {
  try {
    if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
    const prototype = Object.getPrototypeOf(context);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(context);
    if (Object.getOwnPropertySymbols(descriptors).length > 0) return null;
    const callerId = ownData(descriptors, 'callerId')?.value;
    const accountId = ownData(descriptors, 'accountId')?.value;
    const scopes = snapshotScopes(ownData(descriptors, 'scopes')?.value);
    if (!validIdentity(callerId) || !validIdentity(accountId) || scopes === null) return null;
    return {callerId, accountId, scopes, descriptors};
  } catch {
    return null;
  }
}

export function confirmationBinding({callerId, accountId, operation, schemaVersion, args}) {
  return JSON.stringify(canonical({callerId, accountId, operation, schemaVersion, args}));
}

export async function authorize(definition, args, context = {}, confirmationVerifier) {
  const snapshot = snapshotContext(context);
  if (snapshot === null) throw toolError('permission_denied');
  const scopes = new Set(snapshot.scopes);
  if (!definition.scopes.every(scope => scopes.has(scope))) throw toolError('permission_denied');
  if (definition.confirmation !== 'dangerous') return;
  const confirmationToken = ownData(snapshot.descriptors, 'confirmationToken')?.value;
  if (typeof confirmationToken !== 'string' || typeof confirmationVerifier !== 'function') {
    throw toolError('confirmation_required');
  }
  const binding = confirmationBinding({
    callerId: snapshot.callerId,
    accountId: snapshot.accountId,
    operation: definition.name,
    schemaVersion: definition.schemaVersion,
    args
  });
  let valid = false;
  try {
    valid = await confirmationVerifier({token: confirmationToken, binding});
  } catch {}
  if (valid !== true) throw toolError('confirmation_required');
}
