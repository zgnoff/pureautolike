(() => {
  if (window.__palExtBridgeInstalled) return;
  if (!location.hostname.endsWith('pure.app')) return;
  window.__palExtBridgeInstalled = true;

  const state = {
    bearer: '',
    xJsUa: ''
  };
  const CHANNEL = (document.currentScript && document.currentScript.dataset && document.currentScript.dataset.palChannel) || '';
  const NET_BODY_MAX = 128 * 1024;
  const PHOTO_META_CACHE_LIMIT = 120;
  let netSeq = 0;
  const photoMetaCache = new Map();

  function decodeBearerUserId(bearer) {
    try {
      const token = String(bearer || '').replace(/^Bearer\s+/i, '');
      const payload = token.split('.')[1];
      if (!payload) return '';
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
      const data = JSON.parse(atob(normalized));
      return String(data.user_id || data.userId || data.uid || data.sub || '');
    } catch (_) {
      return '';
    }
  }

  function publishToken() {
    window.postMessage({
      source: 'pal-page-bridge',
      channel: CHANNEL,
      type: 'token',
      hasToken: !!state.bearer,
      userId: decodeBearerUserId(state.bearer)
    }, '*');
  }

  function captureHeaders(headers) {
    try {
      let auth = '';
      let xjs = '';
      if (headers instanceof Headers) {
        auth = headers.get('authorization') || '';
        xjs = headers.get('x-js-user-agent') || '';
      } else if (headers && typeof headers === 'object') {
        auth = headers.Authorization || headers.authorization || '';
        xjs = headers['x-js-user-agent'] || headers['X-Js-User-Agent'] || '';
      }
      let changed = false;
      if (auth && String(auth).startsWith('Bearer ') && auth !== state.bearer) {
        state.bearer = String(auth);
        changed = true;
      }
      if (xjs && String(xjs) !== state.xJsUa) {
        state.xJsUa = String(xjs);
        changed = true;
      }
      if (changed) publishToken();
    } catch (_) {}
  }

  function nowSeconds() {
    return Date.now() / 1000;
  }

  function asUrl(value) {
    try {
      if (typeof value === 'string') return value;
      if (value && typeof value.url === 'string') return value.url;
      return String(value || '');
    } catch (_) {
      return '';
    }
  }

  function requestMethod(input, init) {
    return String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  }

  function isPureCaptureUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      const path = parsed.pathname || '';
      if (!parsed.hostname.endsWith('pure.app') && !parsed.hostname.endsWith('thepure.app')) return false;
      return (
        path.includes('/search_likes/') ||
        path.includes('/chats-service/') ||
        path.startsWith('/chats/') ||
        path.includes('/match') ||
        path.includes('/animations/announcement/match-start')
      );
    } catch (_) {
      return false;
    }
  }

  function isPureWebSocketUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      const path = parsed.pathname || '';
      return parsed.hostname.endsWith('thepure.app') && (
        parsed.hostname.includes('x6') ||
        parsed.hostname.includes('centrifugo') ||
        path.includes('/connection/websocket') ||
        path.includes('/chats-service/') && path.endsWith('/ws/')
      );
    } catch (_) {
      return false;
    }
  }

  function boundedText(value) {
    if (typeof value !== 'string' || !value) return '';
    return value.length > NET_BODY_MAX ? value.slice(0, NET_BODY_MAX) : value;
  }

  function publishNetEvent(event) {
    window.postMessage({
      source: 'pal-page-bridge',
      channel: CHANNEL,
      type: 'net-event',
      event: {
        seq: ++netSeq,
        ts: nowSeconds(),
        ...event
      }
    }, '*');
  }

  async function resolveChannelName(chatId) {
    if (!chatId || !state.bearer) return '';
    try {
      const response = await fetch(`https://api.thepure.app/chats/${chatId}`, {
        headers: {'Authorization': state.bearer, 'x-js-user-agent': state.xJsUa || ''},
        credentials: 'omit'
      });
      if (!response.ok) return '';
      const data = await response.json();
      return (data && data.chat && (data.chat.channelName || data.chat.channel)) || data.channelName || data.channel || '';
    } catch (_) {
      return '';
    }
  }

  function usefulPhotoMeta(meta) {
    return !!(meta && (meta.photoId || meta.peerUserId || meta.messageId || meta.chatId || meta.channelName));
  }

  function mergePhotoMeta(primary, fallback) {
    const live = primary || {};
    const cached = fallback || {};
    if (live.messageId && cached.messageId && String(live.messageId) !== String(cached.messageId)) return live;
    if (live.photoId && cached.photoId && String(live.photoId) !== String(cached.photoId)) return live;
    if (live.peerUserId && cached.peerUserId && String(live.peerUserId) !== String(cached.peerUserId)) return live;
    return {
      photoId: live.photoId || cached.photoId || '',
      peerUserId: live.peerUserId || cached.peerUserId || '',
      selfDestructed: !!(live.selfDestructed || cached.selfDestructed),
      channelName: live.channelName || cached.channelName || '',
      chatId: live.chatId || cached.chatId || '',
      messageId: live.messageId || cached.messageId || ''
    };
  }

  function rememberPhotoMeta(key, meta) {
    const cacheKey = String(key || '');
    if (!cacheKey || !usefulPhotoMeta(meta)) return;
    if (photoMetaCache.has(cacheKey)) photoMetaCache.delete(cacheKey);
    photoMetaCache.set(cacheKey, {meta: mergePhotoMeta(meta, {}), createdAt: Date.now()});
    while (photoMetaCache.size > PHOTO_META_CACHE_LIMIT) {
      photoMetaCache.delete(photoMetaCache.keys().next().value);
    }
  }

  function cachedPhotoMeta(key) {
    const cacheKey = String(key || '');
    const cached = photoMetaCache.get(cacheKey);
    if (!cached) return {};
    photoMetaCache.delete(cacheKey);
    photoMetaCache.set(cacheKey, cached);
    return cached.meta || {};
  }

  function photoKeyForRoot(rootEl, explicitKey = '') {
    if (explicitKey) return String(explicitKey);
    try {
      return rootEl && rootEl.getAttribute ? String(rootEl.getAttribute('data-pal-photo-key') || '') : '';
    } catch (_) {
      return '';
    }
  }

  async function resolvePhotoViaHistory(meta) {
    if (!meta || !meta.messageId || !state.bearer) return meta || {};
    let channelName = meta.channelName;
    if (!channelName && meta.chatId) channelName = await resolveChannelName(meta.chatId);
    if (!channelName) return meta;
    try {
      const before = (Date.now() / 1000) + 86400;
      const response = await fetch(`https://api.thepure.app/chats-service/v1/chats/${channelName}/history/?before=${before}&limit=100`, {
        headers: {'Authorization': state.bearer, 'x-js-user-agent': state.xJsUa || ''},
        credentials: 'omit'
      });
      if (!response.ok) return meta;
      const rows = await response.json();
      if (!Array.isArray(rows)) return meta;
      const wanted = String(meta.messageId).toLowerCase();
      for (const row of rows) {
        const inner = row && row.message;
        const id = (inner && inner.id) || row.message_id || '';
        if (String(id).toLowerCase() !== wanted) continue;
        return {
          ...meta,
          photoId: meta.photoId || (inner && inner.p) || '',
          peerUserId: meta.peerUserId || row.user_id || (inner && inner.u) || ''
        };
      }
    } catch (_) {}
    return meta;
  }

  async function fetchPhotoBlob(meta) {
    if (!state.bearer) throw new Error('Pure token is not ready');
    const resolved = await resolvePhotoViaHistory(meta || {});
    if (!resolved.photoId || !resolved.peerUserId) throw new Error('photoId/userId not found');
    const response = await fetch(`https://api.thepure.app/users/${resolved.peerUserId}/albums/profile/${resolved.photoId}`, {
      headers: {'Authorization': state.bearer, 'x-js-user-agent': state.xJsUa || ''},
      credentials: 'omit'
    });
    if (!response.ok) throw new Error(`meta HTTP ${response.status}`);
    const data = await response.json();
    const cdnUrl = data && data.photo && data.photo.original && data.photo.original.url;
    if (!cdnUrl) throw new Error('no cdn url');
    const imageResponse = await fetch(cdnUrl, {
      headers: {'Authorization': state.bearer},
      credentials: 'omit'
    });
    if (!imageResponse.ok) throw new Error(`image HTTP ${imageResponse.status}`);
    return {
      photoId: resolved.photoId,
      blobUrl: URL.createObjectURL(await imageResponse.blob())
    };
  }

  function publishResponseEvent(response, input, init) {
    try {
      const url = asUrl(input);
      if (!isPureCaptureUrl(url)) return;
      const method = requestMethod(input, init);
      const base = {
        kind: 'response',
        method,
        url,
        status: response.status || 0,
        contentType: response.headers && response.headers.get ? (response.headers.get('content-type') || '') : ''
      };
      response.clone().text()
        .then(text => publishNetEvent({
          ...base,
          bodyText: boundedText(text),
          bodyTruncated: typeof text === 'string' && text.length > NET_BODY_MAX
        }))
        .catch(() => publishNetEvent(base));
    } catch (_) {}
  }

  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      captureHeaders(init && init.headers);
      if (input instanceof Request) captureHeaders(input.headers);
    } catch (_) {}
    return originalFetch.apply(this, arguments).then(response => {
      publishResponseEvent(response, input, init);
      return response;
    });
  };

  const originalOpen = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function(method, url) {
    try {
      this.__palNet = {method: String(method || 'GET').toUpperCase(), url: asUrl(url)};
    } catch (_) {}
    return originalOpen.apply(this, arguments);
  };

  const originalSetRequestHeader = window.XMLHttpRequest.prototype.setRequestHeader;
  window.XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    try {
      const lower = String(name).toLowerCase();
      if (lower === 'authorization' || lower === 'x-js-user-agent') {
        captureHeaders({[name]: value});
      }
    } catch (_) {}
    return originalSetRequestHeader.apply(this, arguments);
  };

  const originalSend = window.XMLHttpRequest.prototype.send;
  window.XMLHttpRequest.prototype.send = function() {
    try {
      this.addEventListener('loadend', () => {
        const meta = this.__palNet || {};
        if (!isPureCaptureUrl(meta.url || '')) return;
        let bodyText = '';
        let truncated = false;
        try {
          if (!this.responseType || this.responseType === 'text') {
            const raw = this.responseText || '';
            bodyText = boundedText(raw);
            truncated = raw.length > NET_BODY_MAX;
          }
        } catch (_) {}
        publishNetEvent({
          kind: 'response',
          method: meta.method || 'GET',
          url: meta.url || '',
          status: this.status || 0,
          contentType: this.getResponseHeader('content-type') || '',
          bodyText,
          bodyTruncated: truncated
        });
      });
    } catch (_) {}
    return originalSend.apply(this, arguments);
  };

  function payloadText(payload) {
    if (typeof payload === 'string') return boundedText(payload);
    if (payload instanceof ArrayBuffer || payload instanceof Blob) return '';
    try {
      return boundedText(String(payload || ''));
    } catch (_) {
      return '';
    }
  }

  function hookWebSocket(ws, url) {
    const wsUrl = asUrl(url);
    if (!isPureWebSocketUrl(wsUrl)) return ws;
    try {
      ws.addEventListener('message', event => {
        const text = payloadText(event.data);
        if (!text) return;
        publishNetEvent({
          kind: 'ws_recv',
          url: wsUrl,
          wsPayload: text,
          wsPayloadTruncated: text.length >= NET_BODY_MAX
        });
      });
      const nativeSend = ws.send;
      ws.send = function(payload) {
        const text = payloadText(payload);
        if (text) {
          publishNetEvent({
            kind: 'ws_send',
            url: wsUrl,
            wsPayload: text,
            wsPayloadTruncated: text.length >= NET_BODY_MAX
          });
        }
        return nativeSend.apply(this, arguments);
      };
    } catch (_) {}
    return ws;
  }

  try {
    const NativeWebSocket = window.WebSocket;
    if (NativeWebSocket && !NativeWebSocket.__palProxy) {
      const ProxyWebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
          return hookWebSocket(new target(...args), args[0]);
        },
        apply(target, thisArg, args) {
          return hookWebSocket(target.apply(thisArg, args), args[0]);
        }
      });
      ProxyWebSocket.__palProxy = true;
      window.WebSocket = ProxyWebSocket;
    }
  } catch (_) {}

  function fiberOf(el) {
    for (const key in el) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return el[key];
    }
    return null;
  }

  function propsOf(el) {
    for (const key in el) {
      if (key.startsWith('__reactProps$')) return el[key];
    }
    return null;
  }

  const HEX_RE = /^[a-f0-9]{20,40}$/i;
  const UUID_RE = /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/i;

  function extractPhotoMeta(rootEl) {
    const out = {
      photoId: '',
      peerUserId: '',
      selfDestructed: false,
      channelName: '',
      chatId: '',
      messageId: ''
    };
    const seen = new Set();

    function complete() {
      return out.photoId && out.peerUserId && out.messageId;
    }

    function takeFromObj(obj) {
      if (!obj || typeof obj !== 'object') return;
      for (const key of Object.keys(obj)) {
        let value;
        try { value = obj[key]; } catch (_) { continue; }
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
        if ((key === 'photoId' || key === 'photo_id' || key === 'p') && !out.photoId && value) out.photoId = String(value);
        if ((key === 'self_destructed' || key === 'selfDestructed') && value) out.selfDestructed = true;
        if ((key === 'channelName' || key === 'channel') && !out.channelName && typeof value === 'string') out.channelName = value;
        if ((key === 'chatId' || key === 'chat_id') && !out.chatId && typeof value === 'string' && HEX_RE.test(value)) out.chatId = value;
        if ((key === 'messageId' || key === 'message_id') && !out.messageId && typeof value === 'string') out.messageId = value;
        if (
          (key === 'userId' || key === 'user_id' || key === 'senderUserId' || key === 'sender_user_id' || key === 'u') &&
          typeof value === 'string' && value && value !== '0' && !out.peerUserId
        ) {
          out.peerUserId = value;
        }
      }
    }

    function visitObj(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 6 || seen.has(obj)) return;
      seen.add(obj);
      takeFromObj(obj);
      for (const key of Object.keys(obj)) {
        if (complete()) return;
        let value;
        try { value = obj[key]; } catch (_) { continue; }
        if (value && typeof value === 'object') visitObj(value, depth + 1);
      }
    }

    function visitFiber(fiber) {
      if (!fiber || seen.has(fiber)) return;
      seen.add(fiber);
      if (fiber.memoizedProps) visitObj(fiber.memoizedProps, 0);
      if (fiber.pendingProps) visitObj(fiber.pendingProps, 0);
      if (fiber.stateNode && fiber.stateNode !== window) {
        try { if (fiber.stateNode.props) visitObj(fiber.stateNode.props, 0); } catch (_) {}
        try { if (fiber.stateNode.state) visitObj(fiber.stateNode.state, 0); } catch (_) {}
      }
      if (typeof fiber.key === 'string' && !out.messageId && (UUID_RE.test(fiber.key) || HEX_RE.test(fiber.key))) {
        out.messageId = fiber.key;
      }
    }

    const rootProps = propsOf(rootEl);
    if (rootProps) visitObj(rootProps, 0);
    const rootFiber = fiberOf(rootEl);
    if (rootFiber) visitFiber(rootFiber);

    function descend(fiber, depth) {
      if (!fiber || depth > 6) return;
      visitFiber(fiber);
      if (complete()) return;
      descend(fiber.child, depth + 1);
      if (complete()) return;
      descend(fiber.sibling, depth + 1);
    }
    if (rootFiber) descend(rootFiber.child, 0);

    if (!complete()) {
      const inners = rootEl.querySelectorAll('*');
      for (let i = 0; i < inners.length && i < 70; i += 1) {
        const props = propsOf(inners[i]);
        if (props) visitObj(props, 0);
        if (complete()) break;
        const fiber = fiberOf(inners[i]);
        if (fiber) visitFiber(fiber);
        if (complete()) break;
      }
    }

    if (!out.photoId || !out.messageId || !out.chatId) {
      let fiber = rootFiber && rootFiber.return;
      let hops = 0;
      while (fiber && hops < 30 && (!out.photoId || !out.messageId || !out.chatId)) {
        visitFiber(fiber);
        fiber = fiber.return;
        hops += 1;
      }
    }
    return out;
  }

  function resolvePhotoMetaForRoot(rootEl, explicitKey = '') {
    const key = photoKeyForRoot(rootEl, explicitKey);
    const live = rootEl ? extractPhotoMeta(rootEl) : {};
    const merged = mergePhotoMeta(live, cachedPhotoMeta(key));
    if (key && usefulPhotoMeta(merged)) rememberPhotoMeta(key, merged);
    return merged;
  }

  function validGatewayPublicKey(value) {
    const coordinatePattern = /^[A-Za-z0-9_-]{43}$/;
    return !!(
      value &&
      value.kty === 'EC' &&
      value.crv === 'P-256' &&
      typeof value.x === 'string' && coordinatePattern.test(value.x) &&
      typeof value.y === 'string' && coordinatePattern.test(value.y) &&
      value.d === undefined
    );
  }

  function publishCloudSessionResult(requestId, result) {
    window.postMessage({
      source: 'pal-page-bridge',
      channel: CHANNEL,
      type: 'cloud-session-result',
      requestId: String(requestId || ''),
      ...result
    }, '*');
  }

  function allowlistedCloudSession() {
    return {
      bearer: String(state.bearer || ''),
      xJsUserAgent: String(state.xJsUa || '')
    };
  }

  async function exportCloudSession(data) {
    try {
      const accountBinding = String(data.accountBinding || '');
      const bearerAccount = decodeBearerUserId(state.bearer);
      const createdAt = Number(data.createdAt);
      if (!state.bearer || !bearerAccount) throw new Error('Pure session is not ready');
      if (!validGatewayPublicKey(data.gatewayPublicKey)) throw new Error('Invalid gateway public key');
      if (!accountBinding || accountBinding !== bearerAccount) throw new Error('Account binding mismatch');
      if (!Number.isSafeInteger(createdAt) || Math.abs(Date.now() - createdAt) > 30000) {
        throw new Error('Cloud session request expired');
      }
      if (!globalThis.PalCloudEnvelope || typeof globalThis.PalCloudEnvelope.encryptSession !== 'function') {
        throw new Error('Cloud session encryption unavailable');
      }
      const envelope = await globalThis.PalCloudEnvelope.encryptSession({
        gatewayPublicKey: data.gatewayPublicKey,
        keyId: String(data.keyId || ''),
        accountBinding,
        createdAt,
        session: allowlistedCloudSession()
      });
      publishCloudSessionResult(data.requestId, {ok: true, envelope});
    } catch (error) {
      publishCloudSessionResult(data.requestId, {
        ok: false,
        error: error && error.message ? error.message : 'Cloud session export failed'
      });
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== 'pal-content') return;
    if (data.channel !== CHANNEL) return;

    if (data.type === 'cloud-session-export') {
      exportCloudSession(data);
      return;
    }

    if (data.type === 'get-token') {
      publishToken();
      return;
    }

    if (data.type === 'cache-photo-meta') {
      const root = document.querySelector(`[data-pal-photo-key="${CSS.escape(data.photoKey || '')}"]`);
      if (root) resolvePhotoMetaForRoot(root, data.photoKey || '');
      return;
    }

    if (data.type === 'fetch-photo') {
      const root = document.querySelector(`[data-pal-photo-request="${CSS.escape(data.requestId)}"]`);
      const meta = resolvePhotoMetaForRoot(root, data.photoKey || '');
      fetchPhotoBlob(meta)
        .then(result => {
          window.postMessage({
            source: 'pal-page-bridge',
            channel: CHANNEL,
            type: 'photo-result',
            requestId: data.requestId,
            ok: true,
            photoId: result.photoId || '',
            blobUrl: result.blobUrl || ''
          }, '*');
        })
        .catch(error => {
          window.postMessage({
            source: 'pal-page-bridge',
            channel: CHANNEL,
            type: 'photo-result',
            requestId: data.requestId,
            ok: false,
            error: error.message || String(error)
          }, '*');
        });
    }
  });

  if (globalThis.__PAL_TEST_HOOKS__ && globalThis.__PAL_TEST_HOOKS__.__enabled === true) {
    globalThis.__PAL_TEST_HOOKS__.photoOpener = {
      extractPhotoMeta,
      mergePhotoMeta,
      rememberPhotoMeta,
      cachedPhotoMeta,
      resolvePhotoMetaForRoot
    };
  }

  publishToken();
})();
