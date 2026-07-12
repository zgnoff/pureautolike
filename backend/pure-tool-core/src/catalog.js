function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const EMPTY_INPUT = deepFreeze({type: 'object', properties: {}, additionalProperties: false});

const idInput = key => deepFreeze({
  type: 'object', additionalProperties: false, required: [key],
  properties: {[key]: {type: 'string', minLength: 1, maxLength: 128}}
});

const pageInput = deepFreeze({
  type: 'object', additionalProperties: false,
  properties: {
    cursor: {type: 'string', minLength: 1, maxLength: 512},
    limit: {type: 'integer', minimum: 1, maximum: 100}
  }
});

function define(name, options = {}) {
  return deepFreeze({
    name,
    schemaVersion: '1',
    description: options.description || name,
    executors: Object.freeze(options.executors || ['gateway']),
    scopes: Object.freeze(options.scopes || ['pure:read']),
    confirmation: options.confirmation || 'none',
    mutation: options.mutation || 'read',
    safeFailover: options.safeFailover === true,
    implemented: options.implemented === true,
    inputSchema: options.inputSchema || EMPTY_INPUT
  });
}

const read = (name, options = {}) => define(name, {...options, mutation: 'read', safeFailover: true});
const grant = (name, scope, options = {}) => define(name, {
  ...options, scopes: [scope], confirmation: 'grant', mutation: 'non_idempotent'
});
const dangerous = (name, scope, options = {}) => define(name, {
  ...options, scopes: [scope], confirmation: 'dangerous', mutation: 'destructive'
});

export const CORE_TOOL_DEFINITIONS = Object.freeze([
  read('system.capabilities.list', {executors: ['core'], implemented: true}),
  read('system.operation.get', {executors: ['core'], inputSchema: idInput('requestId')}),
  read('system.workflow.get', {executors: ['core'], inputSchema: idInput('workflowId')}),
  grant('system.workflow.cancel', 'pure:read', {executors: ['core'], inputSchema: idInput('workflowId')}),
  grant('system.confirmation.resolve', 'pure:read', {executors: ['core'], inputSchema: idInput('challengeId')}),

  read('pure.session.status'),
  grant('pure.session.activate', 'pure:account:dangerous'),
  grant('pure.session.rotate', 'pure:account:dangerous'),
  grant('pure.session.reconnect', 'pure:read'),
  dangerous('pure.session.revoke', 'pure:account:dangerous'),
  dangerous('pure.session.delete', 'pure:account:dangerous'),

  read('pure.discovery.state.get'),
  read('pure.discovery.preferences.get'),
  read('pure.discovery.profile.next'),
  read('pure.discovery.profile.get', {inputSchema: idInput('userId')}),
  grant('pure.discovery.reaction.like', 'pure:react', {inputSchema: idInput('userId')}),
  grant('pure.discovery.reaction.skip', 'pure:react', {inputSchema: idInput('userId')}),
  grant('pure.discovery.workflow.start', 'pure:react'),
  grant('pure.discovery.workflow.pause', 'pure:react', {inputSchema: idInput('workflowId')}),
  grant('pure.discovery.workflow.resume', 'pure:react', {inputSchema: idInput('workflowId')}),
  grant('pure.discovery.workflow.stop', 'pure:react', {inputSchema: idInput('workflowId')}),
  read('pure.discovery.workflow.status', {inputSchema: idInput('workflowId')}),

  read('pure.matches.list', {inputSchema: pageInput}),
  read('pure.matches.get', {inputSchema: idInput('matchId')}),
  dangerous('pure.matches.block', 'pure:account:dangerous', {inputSchema: idInput('matchId')}),
  dangerous('pure.matches.report', 'pure:account:dangerous', {inputSchema: idInput('matchId')}),
  dangerous('pure.matches.unmatch', 'pure:account:dangerous', {inputSchema: idInput('matchId')}),
  dangerous('pure.matches.remove', 'pure:account:dangerous', {inputSchema: idInput('matchId')}),

  read('pure.chats.list', {inputSchema: pageInput}),
  read('pure.chats.get', {inputSchema: idInput('chatId')}),
  read('pure.chats.history.list', {inputSchema: idInput('chatId')}),
  read('pure.chats.events.list', {inputSchema: pageInput}),
  grant('pure.chats.message.send', 'pure:message', {inputSchema: idInput('chatId')}),
  grant('pure.chats.read.mark', 'pure:message', {inputSchema: idInput('chatId')}),
  dangerous('pure.chats.delete', 'pure:account:dangerous', {inputSchema: idInput('chatId')}),
  dangerous('pure.chats.clear', 'pure:account:dangerous', {inputSchema: idInput('chatId')}),

  read('pure.media.profile_photos.list', {inputSchema: idInput('userId')}),
  read('pure.media.photo.get', {inputSchema: idInput('mediaId')}),
  read('pure.media.download', {inputSchema: idInput('mediaId')}),
  grant('pure.media.upload', 'pure:media'),
  read('pure.media.transfer.status', {inputSchema: idInput('transferId')}),

  read('pure.profile.get'),
  grant('pure.profile.update', 'pure:profile:write'),
  grant('pure.profile.photos.upload', 'pure:profile:write'),
  grant('pure.profile.photos.reorder', 'pure:profile:write'),
  dangerous('pure.profile.photos.delete', 'pure:profile:write', {inputSchema: idInput('photoId')}),
  read('pure.profile.location.get'),
  dangerous('pure.profile.location.update', 'pure:profile:write'),
  dangerous('pure.profile.visibility.update', 'pure:profile:write'),

  read('extension.autolike.status', {executors: ['extension'], scopes: ['extension:control']}),
  read('extension.autolike.config.get', {executors: ['extension'], scopes: ['extension:control']}),
  grant('extension.autolike.config.update', 'extension:control', {executors: ['extension']}),
  grant('extension.autolike.start', 'extension:control', {executors: ['extension']}),
  grant('extension.autolike.pause', 'extension:control', {executors: ['extension']}),
  grant('extension.autolike.resume', 'extension:control', {executors: ['extension']}),
  grant('extension.autolike.stop', 'extension:control', {executors: ['extension']}),
  read('extension.autolike.stats', {executors: ['extension'], scopes: ['extension:control']}),

  read('extension.telegram.status', {executors: ['extension'], scopes: ['telegram:control']}),
  grant('extension.telegram.connect', 'telegram:control', {executors: ['extension']}),
  grant('extension.telegram.test', 'telegram:control', {executors: ['extension']}),
  grant('extension.telegram.pause', 'telegram:control', {executors: ['extension']}),
  grant('extension.telegram.resume', 'telegram:control', {executors: ['extension']}),
  dangerous('extension.telegram.disconnect', 'telegram:control', {executors: ['extension']}),

  read('extension.browser.status', {executors: ['extension'], scopes: ['extension:control']}),
  grant('extension.browser.tab.open', 'extension:control', {executors: ['extension']}),
  grant('extension.browser.tab.focus', 'extension:control', {executors: ['extension']}),
  grant('extension.browser.operation.request', 'extension:control', {executors: ['extension']})
]);
