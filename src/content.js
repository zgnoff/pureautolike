(() => {
  if (window.__palContentInstalled) return;
  if (!location.hostname.endsWith('pure.app')) return;
  window.__palContentInstalled = true;

  const ext = globalThis.chrome || globalThis.browser;
  const BRIDGE_CHANNEL = `pal:${ext.runtime.id}:${Math.random().toString(36).slice(2)}:${Date.now().toString(36)}`;
  const HEART_PATH_PREFIX = 'M16.0004 30.7899';
  const NEGATIVE_TEXT_HINTS = [
    'скинуть', 'спрятаться', 'skip', 'pass', 'корону', 'царь', 'царем',
    'отправить', 'начать чат', 'в игре'
  ];
  const MATCH_ACTIONS = new Set(['addition', 'added', 'add', 'created', 'create', 'match', 'matched']);
  const LIKE_MODULES = new Set(['like', 'likes', 'reaction', 'reactions', 'search_likes']);
  const LIKE_ACTIONS = new Set(['like', 'liked', 'like_added', 'liked_you', 'received', 'new_like', 'reaction_added']);
  const LIKE_COUNT_KEYS = ['count', 'total', 'total_count', 'likes_count', 'like_count', 'search_likes_count', 'unseen_count', 'new_count'];
  const PROFILE_LIST_KEYS = ['results', 'feed', 'users', 'items', 'profiles', 'data'];
  const PROFILE_ID_KEYS = ['user_id', 'userId', 'uid', 'id', '_id'];
  const PROFILE_LABEL_KEYS = ['name', 'display_name', 'displayName', 'nickname', 'label'];
  const THREAD_ID_KEYS = ['id', '_id', 'channelName', 'channel', 'thread_id', 'chat_id'];
  const MESSAGE_ID_KEYS = ['message_id', 'id', 'uid', 'uuid', '_id'];
  const MESSAGE_TEXT_KEYS = ['text', 'content', 'message', 'body', 'msg', 'm'];
  const MESSAGE_NESTED_KEYS = ['body', 'message', 'content', 'payload', 'data'];
  const MESSAGE_SENDER_KEYS = ['sender_id', 'sender_user_id', 'from_user_id', 'user_id', 'author_id', 'owner_id', 'from', 'u'];
  const MESSAGE_KIND_KEYS = ['type', 'kind', 'message_type', 'msg_type'];
  const CHAT_ID_KEYS = ['chat_id', 'thread_id', 'conversation_id', 'room_id', 'channel', 'channelName'];
  const MESSAGE_KINDS = new Set(['text', 'image', 'photo', 'picture', 'video', 'audio', 'voice', 'sticker', 'gif', 'file', 'document', 'attachment', 'location', 'media']);
  const MATCH_DEDUP_SECONDS = 20;
  const HISTORY_MESSAGE_RECENCY_SECONDS = 10 * 60;
  const SEEN_SIGNATURE_LIMIT = 3000;
  const NOTIFICATION_MEMORY_LIMIT = 2500;
  const PROFILE_CAPTURE_KEY = 'palProfileCaptures';
  const PROFILE_CAPTURE_INDEX_KEY = 'palProfileCaptureIndex';
  const PROFILE_CAPTURE_CHUNK_PREFIX = 'palProfileCaptureChunk:';
  const PROFILE_CAPTURE_CHUNK_SIZE = 100;
  const PROFILE_CAPTURE_TEXT_LIMIT = 1800;
  const PROFILE_DESCRIPTION_KEY_LIMIT = 220;
  const SESSION_STATS_KEY = 'palSessionStats';
  const STATS_FLUSH_MS = 700;
  const PHOTO_CACHE_LIMIT = 40;
  const PHOTO_META_REFRESH_MS = 5000;
  const MAX_TIMER_MS = 2147483647;
  const CLICK_CONFIRM_MS = 520;
  const CLICK_RETRY_CONFIRM_MS = 720;
  const CLICK_MISS_HOLD_LIMIT = 2;
  const EMPTY_RENDER_GRACE_MS = 110;
  const DEFAULTS = {
    enabled: false,
    useDebugger: true,
    humanizeMouse: true,
    photoOpener: true,
    sessionLimit: 0,
    clickJitter: 0.25,
    telegramEnabled: false,
    telegramMatches: true,
    telegramMessages: true,
    telegramLikes: true,
    autoStopMinutes: 0,
    closeTabMinutes: 0,
    profileCaptureEnabled: false
  };
  const NATIVE_SETTINGS = {
    humanizeMouse: true,
    photoOpener: true,
    sessionLimit: 0
  };

  const runtime = {
    settings: {...DEFAULTS},
    hasToken: false,
    myUserId: '',
    capabilities: {debugger: false, clickMode: 'dom'},
    running: false,
    starting: false,
    runnerLock: false,
    runnerOwner: null,
    runnerHeartbeatTimer: 0,
    autoStopTimer: 0,
    closeTabTimer: 0,
    timerDeadlines: {autoStopAt: '', closeTabAt: ''},
    timerMode: 'content',
    timerStopInProgress: false,
    likes: 0,
    failures: 0,
    sessionStats: null,
    sessionStatsLoaded: false,
    sessionStatsDirty: false,
    sessionStatsFlushTimer: 0,
    lastError: '',
    loopTimer: 0,
    lastScrollTop: -1,
    stagnantScrolls: 0,
    seen: new Set(),
    seenQueue: [],
    clickMisses: new Map(),
    photoCache: new Map(),
    pendingPhoto: new Map(),
    photoDecorateTimer: 0,
    badgePositionAt: 0,
    engagementDetector: null,
    telegramSent: 0,
    telegramConfigured: false,
    telegramLastError: '',
    telegramLastEvent: null,
    diagnostics: {
      lastTickAt: '',
      lastHeartbeatAt: '',
      lastScrollAt: '',
      lastScrollMoved: null,
      lastVisibleProfiles: 0,
      lastLikeTargets: 0,
      lastAttempted: 0,
      lastNetEventAt: '',
      lastNetEventKind: '',
      lastNetEventUrl: ''
    },
    profileCaptures: [],
    profileCaptureSeen: new Set(),
    profileCaptureDescriptionSeen: new Set(),
    profileCaptureDirty: false,
    profileCaptureFlushTimer: 0,
    profileCaptureLoaded: false,
    profileCaptureStoredCount: 0,
    profileCaptureLastError: '',
    profileCaptureStorage: {mode: 'legacy', count: 0, chunks: 0, bytes: 0}
  };

  const FRAME_FALLBACK_MS = 80;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function nextFrame() {
    return new Promise(resolve => {
      let done = false;
      let frameTimer = 0;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(frameTimer);
        resolve();
      };
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (window.requestAnimationFrame && !hidden) {
        frameTimer = setTimeout(finish, FRAME_FALLBACK_MS);
        window.requestAnimationFrame(finish);
        return;
      }
      setTimeout(finish, 16);
    });
  }
  const norm = value => String(value || '').replace(/\s+/g, ' ').trim();

  function storageGet(defaults) {
    const result = ext.storage.local.get(defaults);
    if (result && typeof result.then === 'function') return result;
    return new Promise(resolve => ext.storage.local.get(defaults, resolve));
  }

  function storageSet(values) {
    const result = ext.storage.local.set(values);
    if (result && typeof result.then === 'function') return result;
    return new Promise(resolve => ext.storage.local.set(values, resolve));
  }

  function storageRemove(keys) {
    const result = ext.storage.local.remove(keys);
    if (result && typeof result.then === 'function') return result;
    return new Promise(resolve => ext.storage.local.remove(keys, resolve));
  }

  function defaultSessionStats() {
    return {
      likes: 0,
      failures: 0,
      startedAt: '',
      updatedAt: '',
      lastTickAt: '',
      lastProfileCaptureAt: '',
      profileCaptureCount: 0
    };
  }

  function normalizeSessionStats(value) {
    const input = value && typeof value === 'object' ? value : {};
    return {
      ...defaultSessionStats(),
      likes: Math.max(0, Number(input.likes) || 0),
      failures: Math.max(0, Number(input.failures) || 0),
      startedAt: String(input.startedAt || ''),
      updatedAt: String(input.updatedAt || ''),
      lastTickAt: String(input.lastTickAt || ''),
      lastProfileCaptureAt: String(input.lastProfileCaptureAt || ''),
      profileCaptureCount: Math.max(0, Number(input.profileCaptureCount) || 0)
    };
  }

  async function loadSessionStats() {
    if (runtime.sessionStatsLoaded) return runtime.sessionStats;
    const data = await storageGet({[SESSION_STATS_KEY]: defaultSessionStats()});
    runtime.sessionStats = normalizeSessionStats(data[SESSION_STATS_KEY]);
    runtime.sessionStatsLoaded = true;
    runtime.likes = runtime.sessionStats.likes;
    runtime.failures = runtime.sessionStats.failures;
    return runtime.sessionStats;
  }

  function scheduleSessionStatsFlush() {
    if (runtime.sessionStatsFlushTimer) return;
    runtime.sessionStatsFlushTimer = window.setTimeout(() => {
      runtime.sessionStatsFlushTimer = 0;
      void flushSessionStats();
    }, STATS_FLUSH_MS);
  }

  async function flushSessionStats() {
    clearTimeout(runtime.sessionStatsFlushTimer);
    runtime.sessionStatsFlushTimer = 0;
    if (!runtime.sessionStatsLoaded) await loadSessionStats();
    if (!runtime.sessionStatsDirty) return runtime.sessionStats;
    runtime.sessionStats.updatedAt = new Date().toISOString();
    await storageSet({[SESSION_STATS_KEY]: runtime.sessionStats});
    runtime.sessionStatsDirty = false;
    return runtime.sessionStats;
  }

  function updateSessionStats(patch = {}) {
    if (!runtime.sessionStatsLoaded) return;
    runtime.sessionStats = normalizeSessionStats({
      ...runtime.sessionStats,
      ...patch,
      likes: runtime.likes,
      failures: runtime.failures,
      updatedAt: new Date().toISOString()
    });
    runtime.sessionStatsDirty = true;
    scheduleSessionStatsFlush();
  }

  async function resetSessionStats() {
    const now = new Date().toISOString();
    runtime.sessionStats = normalizeSessionStats({startedAt: now, updatedAt: now});
    runtime.sessionStatsLoaded = true;
    runtime.sessionStatsDirty = false;
    runtime.likes = 0;
    runtime.failures = 0;
    await storageSet({[SESSION_STATS_KEY]: runtime.sessionStats});
  }

  function normalizeSettings(settings, capabilities = runtime.capabilities) {
    return {
      ...DEFAULTS,
      ...settings,
      autoStopMinutes: normalizeTimerMinutes(settings.autoStopMinutes),
      closeTabMinutes: normalizeTimerMinutes(settings.closeTabMinutes),
      ...NATIVE_SETTINGS,
      useDebugger: capabilities && capabilities.debugger !== false
    };
  }

  function normalizeTimerMinutes(value) {
    const minutes = Number.parseInt(String(value ?? 0), 10);
    if (!Number.isFinite(minutes) || minutes <= 0) return 0;
    return Math.min(minutes, 1440);
  }

  function injectPageBridge() {
    const root = document.documentElement || document.head;
    if (!root) {
      setTimeout(injectPageBridge, 0);
      return;
    }
    if (root.querySelector('script[data-pal-page-bridge]')) return;
    if (root.querySelector('script[data-pal-cloud-envelope]')) return;
    const envelopeScript = document.createElement('script');
    envelopeScript.dataset.palCloudEnvelope = '1';
    envelopeScript.src = ext.runtime.getURL('src/cloud-session-envelope.js');
    envelopeScript.onload = () => {
      envelopeScript.remove();
      const bridgeScript = document.createElement('script');
      bridgeScript.dataset.palPageBridge = '1';
      bridgeScript.dataset.palChannel = BRIDGE_CHANNEL;
      bridgeScript.src = ext.runtime.getURL('src/page-bridge.js');
      bridgeScript.onload = () => bridgeScript.remove();
      (document.head || root).appendChild(bridgeScript);
    };
    (document.head || root).appendChild(envelopeScript);
  }

  function imageHashesFromUrls(images) {
    const hashes = [];
    for (const url of images || []) {
      if (String(url).includes('static/media/pretzel')) continue;
      const match = String(url).match(/\/([A-Za-z0-9_-]{16,})\.(?:png|jpe?g|webp)/i);
      if (match) hashes.push(match[1]);
    }
    return Array.from(new Set(hashes));
  }

  function signatureFor(images, text) {
    const hashes = imageHashesFromUrls(images);
    const label = (text || hashes[0] || 'unknown').slice(0, 80);
    if (hashes.length) return {key: 'img:' + hashes.sort().join('|'), label, hashes};
    if (text) return {key: 'txt:' + text, label, hashes};
    return {key: 'none:' + Math.random().toString(36), label, hashes};
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight;
  }

  function pathPrefix(btn) {
    const path = btn.querySelector('path');
    return path ? (path.getAttribute('d') || '') : '';
  }

  function buttonLabel(btn) {
    return norm(btn.innerText || btn.getAttribute('aria-label') || btn.getAttribute('title')).toLowerCase();
  }

  function isNegative(text) {
    return NEGATIVE_TEXT_HINTS.some(hint => text.includes(hint));
  }

  function isPositiveLikeLabel(text) {
    return /(?:^|[\s:;,.!?])(like|лайк|нравится|сердце|heart)(?:$|[\s:;,.!?])/i.test(text || '');
  }

  function isLikeButton(btn) {
    const labelText = buttonLabel(btn);
    if (isNegative(labelText)) return false;
    const path = pathPrefix(btn);
    if (path && path.startsWith(HEART_PATH_PREFIX)) return true;
    return isPositiveLikeLabel(labelText);
  }

  function cardFor(btn) {
    let card = btn;
    let cur = btn;
    while (cur && cur !== document.body) {
      const r = cur.getBoundingClientRect();
      if (r.width >= 240 && r.height >= 200) {
        card = cur;
        break;
      }
      cur = cur.parentElement;
    }
    return card;
  }

  function imagesFromCard(card) {
    const images = [];
    if (!card || typeof card.querySelectorAll !== 'function') return images;
    for (const img of card.querySelectorAll('img')) {
      const src = img.src || '';
      if (src.includes('cdn.thepure.app') || src.includes('/avatars/') || src.includes('/feed/')) images.push(src);
    }
    for (const el of card.querySelectorAll('*')) {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none' && bg.includes('cdn.thepure.app')) {
        const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (match) images.push(match[1]);
      }
    }
    return images;
  }

  function signatureDataFromCard(card) {
    const images = imagesFromCard(card);
    const rawText = card.innerText || '';
    const profile = runtime.settings.profileCaptureEnabled ? profileDataFromCard(card) : null;
    const description = profile ? profile.description : '';
    return {images, text: norm(description || rawText).slice(0, 160), description, profile};
  }

  function signatureData(btn) {
    return signatureDataFromCard(cardFor(btn));
  }

  function profileDescriptionFromCard(card) {
    return profileDataFromCard(card).description;
  }

  function profileDataFromCard(card) {
    return profileFieldsFromText(String(card && card.innerText || ''));
  }

  function profileLinesFromText(text) {
    const lines = String(text || '')
      .split(/\n+/)
      .map(line => norm(line))
      .filter(Boolean);
    const seen = new Set();
    const cleaned = [];
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (seen.has(lower)) continue;
      if (isProfileNoiseLine(line)) continue;
      if (/^[.:;,\s·•]+$/.test(line)) continue;
      if (/pureautolike/i.test(line)) continue;
      seen.add(lower);
      cleaned.push(line);
      if (cleaned.join('\n').length >= PROFILE_CAPTURE_TEXT_LIMIT) break;
    }
    return cleaned;
  }

  function isProfileNoiseLine(line) {
    const value = norm(line);
    if (!value) return true;
    if (/^(new|on|off|ok|autolike|lock)$/i.test(value)) return true;
    if (/^(открыть|загрузка|скрыть|спрятаться)$/i.test(value)) return true;
    if (/^[a-z]{2}(?:\s*\/\s*[a-z]{2})+$/i.test(value)) return true;
    if (/^\d+\s*(?:км|km|м|m)(?:$|[\s.,;:!?]).*(?:онлайн|online)?$/i.test(value)) return true;
    if (/^\d+\s*(?:соблазн|соблазна|соблазнов)\.?$/i.test(value)) return true;
    if (/^возраст\s+\d+\s*[-–]\s*\d+/i.test(value)) return true;
    return false;
  }

  function stripLanguagePrefix(line) {
    return norm(line).replace(/^(?:[a-z]{2}\s*\/\s*)+[a-z]{2}\s*/i, '').trim();
  }

  function cleanStatusText(text) {
    return norm(text)
      .replace(/^[^A-Za-zА-Яа-яЁё0-9]+/u, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function statusFromLine(line) {
    const value = cleanStatusText(stripLanguagePrefix(line));
    const patterns = [
      {label: 'Всё, везде и сразу', re: /вс[её]\s*,?\s*везде\s+и\s+сразу/i},
      {label: 'Всё серьёзно', re: /вс[её]\s+серь[её]зно/i},
      {label: 'Без обязательств', re: /без\s+обязательств/i},
      {label: 'Вирт', re: /(?:^|[\s.,;:!?])вирт(?:$|[\s.,;:!?])/i},
      {label: 'FWB', re: /\bfwb\b/i},
      {label: 'Соблазны', re: /(?:^|[\s.,;:!?])соблазн(?:ы|а|ов|ый|ое)?(?:$|[\s.,;:!?])/i}
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern.re);
      if (!match) continue;
      const tail = value.slice(match.index + match[0].length).replace(/^[\s.:;,\-–—]+/, '').trim();
      return {status: pattern.label, rest: tail};
    }
    return {status: '', rest: value};
  }

  function ageFromLine(line) {
    const match = norm(line).match(/(?:^|[^\d])([1-9]\d)\s*(?:лет|года|год)(?:$|[\s.,;:!?])/i);
    if (!match) return '';
    const age = Number(match[1]);
    return age >= 18 && age <= 80 ? String(age) : '';
  }

  function isProfileMetaLine(line) {
    const value = norm(line);
    if (isProfileNoiseLine(value)) return true;
    if (/(?:^|[^\d])\d{2}\s*(?:лет|года|год)(?:$|[\s.,;:!?])/i.test(value)) return true;
    if (/\b\d{2,3}\s*см\b/i.test(value)) return true;
    if (/^(?:москва|санкт[-\s]петербург|спб|девушка|парень|мужчина|женщина)(?:$|[\s.,;:!?])/i.test(value)) return true;
    return false;
  }

  function descriptionKeyForText(text) {
    const value = norm(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, PROFILE_DESCRIPTION_KEY_LIMIT);
    return value ? `desc:${stableHash(value)}` : '';
  }

  function profileFieldsFromText(text) {
    const lines = profileLinesFromText(text);
    const descriptionLines = [];
    let status = '';
    let age = '';

    for (const line of lines) {
      if (!age) age = ageFromLine(line);
      const statusInfo = statusFromLine(line);
      if (!status && statusInfo.status) status = statusInfo.status;
      if (statusInfo.status) {
        if (statusInfo.rest && !isProfileMetaLine(statusInfo.rest)) descriptionLines.push(statusInfo.rest);
        continue;
      }
      const withoutLanguage = stripLanguagePrefix(line);
      if (!withoutLanguage || isProfileMetaLine(withoutLanguage)) continue;
      descriptionLines.push(withoutLanguage);
    }

    const description = descriptionLines.join('\n').slice(0, PROFILE_CAPTURE_TEXT_LIMIT).trim();
    return {
      status,
      age,
      description,
      descriptionKey: descriptionKeyForText(description),
      rawText: lines.join('\n').slice(0, PROFILE_CAPTURE_TEXT_LIMIT)
    };
  }

  function profileCandidateFromCard(card) {
    if (!card) return null;
    const sigData = signatureDataFromCard(card);
    const profile = sigData.profile || profileDataFromCard(card);
    const description = String(profile.description || sigData.description || '').trim();
    if (description.length < 12) return null;
    const sig = signatureFor(sigData.images, description);
    return {
      top: Math.round(card.getBoundingClientRect ? card.getBoundingClientRect().top : 0),
      signature: sig.key,
      label: sig.label,
      hashes: sig.hashes,
      description,
      profile
    };
  }

  function visibleProfileCardElements() {
    const cards = [];
    const seen = new Set();
    const addCard = card => {
      if (!card || seen.has(card) || !isVisible(card)) return;
      const rect = card.getBoundingClientRect();
      if (rect.width < 240 || rect.height < 140) return;
      const candidate = profileCandidateFromCard(card);
      if (!candidate) return;
      seen.add(card);
      cards.push(card);
    };

    const list = document.querySelector('#recommendations-list');
    if (list) {
      for (const card of list.querySelectorAll(':scope > div > div, :scope > div, article, [role="article"]')) addCard(card);
    }

    if (!cards.length) {
      for (const card of document.querySelectorAll('article,[role="article"]')) addCard(card);
    }

    if (!cards.length) {
      const scroller = feedScroller();
      const root = scroller && scroller !== rootScroller() ? scroller : document;
      for (const btn of root.querySelectorAll('button,[role="button"]')) addCard(cardFor(btn));
    }

    cards.sort((a, b) => Math.round(a.getBoundingClientRect().top) - Math.round(b.getBoundingClientRect().top));
    return cards;
  }

  function detectLikeButtons() {
    const buttons = [];
    for (const btn of document.querySelectorAll('button,[role="button"]')) {
      if (!isVisible(btn)) continue;
      if (!isLikeButton(btn)) continue;
      const rect = btn.getBoundingClientRect();
      const sigData = signatureData(btn);
      const sig = signatureFor(sigData.images, sigData.text);
      buttons.push({
        el: btn,
        top: Math.round(rect.top),
        box: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        },
        signature: sig.key,
        label: sig.label,
        hashes: sig.hashes,
        description: sigData.description,
        profile: sigData.profile
      });
    }
    buttons.sort((a, b) => a.top - b.top);
    return buttons;
  }

  function rootScroller() {
    return document.scrollingElement || document.documentElement;
  }

  function canScroll(el) {
    if (!el || !el.isConnected) return false;
    if (el === document.body || el === document.documentElement || el === rootScroller()) {
      return rootScroller().scrollHeight - innerHeight > 40;
    }
    const style = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(style.overflowY)) return false;
    return el.scrollHeight - el.clientHeight > 40;
  }

  function scrollTopOf(el) {
    if (el === rootScroller() || el === document.body || el === document.documentElement) {
      return rootScroller().scrollTop || window.scrollY || 0;
    }
    return el.scrollTop;
  }

  function findScrollableAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (canScroll(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function feedScroller() {
    const list = document.querySelector('#recommendations-list');
    const fromList = list && findScrollableAncestor(list);
    if (fromList) return fromList;

    const firstLike = document.querySelector(`path[d^="${HEART_PATH_PREFIX}"]`);
    const fromLike = firstLike && findScrollableAncestor(firstLike);
    if (fromLike) return fromLike;

    let best = null;
    let bestScore = -1;
    for (const el of document.querySelectorAll('main,section,div')) {
      if (!canScroll(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 280 || rect.height < 220 || rect.bottom < 80 || rect.top > innerHeight - 80) continue;
      const hasFeed = !!el.querySelector('#recommendations-list');
      const hasLike = !!el.querySelector(`path[d^="${HEART_PATH_PREFIX}"]`);
      const score =
        (hasFeed ? 100000 : 0) +
        (hasLike ? 50000 : 0) +
        Math.min(el.scrollHeight - el.clientHeight, 20000) +
        Math.min(rect.width * rect.height / 1000, 10000);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }

    if (best) return best;
    return canScroll(rootScroller()) ? rootScroller() : null;
  }

  function scrollFeed() {
    const scroller = feedScroller();
    const viewport = scroller && scroller !== rootScroller() ? scroller.clientHeight : innerHeight;
    const distance = Math.max(360, Math.round(viewport * 0.68));
    const before = scroller ? scrollTopOf(scroller) : 0;

    if (scroller && scroller !== rootScroller()) {
      scroller.scrollBy({top: distance, behavior: 'auto'});
    } else {
      window.scrollBy({top: distance, behavior: 'auto'});
      rootScroller().scrollTop += distance;
    }

    const list = document.querySelector('#recommendations-list');
    if (list) {
      const cards = list.querySelectorAll(':scope > div > div, :scope > div, article, [role="article"]');
      const last = cards[cards.length - 1];
      if (last && (!scroller || Math.abs(scrollTopOf(scroller) - before) < 4)) {
        last.scrollIntoView({block: 'end', inline: 'nearest', behavior: 'auto'});
      }
    }

    const after = scroller ? scrollTopOf(scroller) : scrollTopOf(rootScroller());
    runtime.diagnostics.lastScrollAt = new Date().toISOString();
    runtime.diagnostics.lastScrollMoved = Math.abs(after - before) >= 4;
    if (Math.abs(after - before) < 4 && runtime.lastScrollTop === after) {
      runtime.stagnantScrolls += 1;
    } else {
      runtime.stagnantScrolls = 0;
      if (runtime.lastError === 'feed scroll did not move') runtime.lastError = '';
    }
    runtime.lastScrollTop = after;
    runtime.lastError = runtime.stagnantScrolls > 4 ? 'feed scroll did not move' : runtime.lastError;
  }

  function snapshot(btn) {
    if (!btn || !btn.isConnected) return null;
    return {
      className: String(btn.className || ''),
      ariaPressed: btn.getAttribute('aria-pressed') || '',
      disabled: !!btn.disabled,
      pathFill: btn.querySelector('path')?.getAttribute('fill') || '',
      svgHTML: String(btn.querySelector('svg')?.outerHTML || '').slice(0, 200)
    };
  }

  function reacted(btn, before) {
    if (!btn || !btn.isConnected) return true;
    if (!before) return false;
    const after = snapshot(btn);
    if (!after) return true;
    return (
      after.disabled ||
      after.ariaPressed === 'true' ||
      before.className !== after.className ||
      before.ariaPressed !== after.ariaPressed ||
      before.pathFill !== after.pathFill ||
      before.svgHTML !== after.svgHTML
    );
  }

  async function confirmReaction(btn, before, timeoutMs = CLICK_CONFIRM_MS) {
    if (reacted(btn, before)) return true;
    return new Promise(resolve => {
      let settled = false;
      let observer = null;
      let tick = 0;
      let timeout = 0;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(tick);
        if (observer) observer.disconnect();
        resolve(value);
      };
      const check = () => {
        if (reacted(btn, before)) finish(true);
      };
      if (btn && btn.isConnected) {
        observer = new MutationObserver(check);
        observer.observe(btn, {attributes: true, childList: true, subtree: true, characterData: true});
      }
      tick = setInterval(check, 40);
      timeout = setTimeout(() => finish(reacted(btn, before)), timeoutMs);
    });
  }

  function jitteredPoint(box) {
    const ratio = runtime.settings.clickJitter || 0;
    const maxX = Math.max(0, box.width * ratio * 0.5);
    const maxY = Math.max(0, box.height * ratio * 0.5);
    return {
      x: box.x + box.width / 2 + (Math.random() * 2 - 1) * maxX,
      y: box.y + box.height / 2 + (Math.random() * 2 - 1) * maxY
    };
  }

  function centerPoint(box) {
    return {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2
    };
  }

  function pointInViewport(point) {
    return point.x >= 0 && point.y >= 0 && point.x < innerWidth && point.y < innerHeight;
  }

  function pointTargetsButton(btn, point) {
    if (!pointInViewport(point)) return false;
    const target = document.elementFromPoint(point.x, point.y);
    return !!(target && (target === btn || btn.contains(target)));
  }

  function sendRuntime(message) {
    return new Promise(resolve => {
      ext.runtime.sendMessage(message, response => resolve(response || {ok: false, error: ext.runtime.lastError?.message || 'no response'}));
    });
  }

  async function loadCapabilities() {
    const response = await sendRuntime({type: 'pal-capabilities'});
    runtime.capabilities = {
      debugger: !!(response && response.debugger),
      clickMode: response && response.clickMode ? response.clickMode : 'dom'
    };
  }

  function safeJson(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      const items = [];
      for (const line of text.split(/\n+/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          items.push(JSON.parse(trimmed));
        } catch (_) {
          return null;
        }
      }
      return items.length ? items : null;
    }
  }

  function eventTs(event) {
    const value = Number(event && event.ts);
    return Number.isFinite(value) && value > 0 ? value : Date.now() / 1000;
  }

  function pathOf(url) {
    try {
      return new URL(String(url || ''), location.href).pathname || '';
    } catch (_) {
      return '';
    }
  }

  function stableHash(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function getPushData(body) {
    if (Array.isArray(body)) {
      for (const item of body) {
        const found = getPushData(item);
        if (found) return found;
      }
      return null;
    }
    if (!body || typeof body !== 'object') return null;
    const push = body.push;
    if (push && typeof push === 'object') {
      const pub = push.pub;
      if (pub && typeof pub === 'object' && pub.data && typeof pub.data === 'object') return pub.data;
    }
    const pub = body.pub;
    if (pub && typeof pub === 'object' && pub.data && typeof pub.data === 'object') return pub.data;
    return null;
  }

  function firstString(obj, keys) {
    if (!obj || typeof obj !== 'object') return '';
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'string' && value) return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return '';
  }

  function firstStringDeep(obj, keys) {
    const direct = firstString(obj, keys);
    if (direct) return direct;
    if (!obj || typeof obj !== 'object') return '';
    for (const key of MESSAGE_NESTED_KEYS) {
      const nested = obj[key];
      const value = firstString(nested, keys);
      if (value) return value;
    }
    return '';
  }

  function coerceInt(value) {
    if (typeof value === 'boolean') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && value.trim() && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
    return null;
  }

  function extractCount(body) {
    const direct = coerceInt(body);
    if (direct != null) return direct;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    for (const key of LIKE_COUNT_KEYS) {
      const count = coerceInt(body[key]);
      if (count != null) return count;
    }
    for (const value of Object.values(body)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested = extractCount(value);
        if (nested != null) return nested;
      }
    }
    return null;
  }

  function looksProfile(item) {
    return !!firstString(item, PROFILE_ID_KEYS);
  }

  function profileFromDict(item) {
    if (!item || typeof item !== 'object') return null;
    const userId = firstString(item, PROFILE_ID_KEYS);
    if (!userId) return null;
    return {
      userId,
      label: firstString(item, PROFILE_LABEL_KEYS)
    };
  }

  function profileItems(body) {
    if (Array.isArray(body)) return body.filter(item => item && typeof item === 'object');
    if (!body || typeof body !== 'object') return [];
    for (const key of PROFILE_LIST_KEYS) {
      const value = body[key];
      if (Array.isArray(value)) {
        const items = value.filter(item => item && typeof item === 'object');
        if (items.length && looksProfile(items[0])) return items;
      }
    }
    for (const value of Object.values(body)) {
      if (Array.isArray(value)) {
        const items = value.filter(item => item && typeof item === 'object');
        if (items.length && looksProfile(items[0])) return items;
      }
      if (value && typeof value === 'object') {
        const nested = profileItems(value);
        if (nested.length) return nested;
      }
    }
    return [];
  }

  function extractLikeProfiles(body) {
    return profileItems(body).map(profileFromDict).filter(Boolean);
  }

  function threadId(payload) {
    return firstString(payload, THREAD_ID_KEYS);
  }

  function unwrapChat(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    for (const key of ['chat', 'data', 'result']) {
      if (body[key] && typeof body[key] === 'object' && !Array.isArray(body[key])) return body[key];
    }
    return body;
  }

  function coerceTimestamp(value) {
    if (typeof value === 'boolean' || value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value > 10000000000 ? value / 1000 : value;
    }
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return coerceTimestamp(numeric);
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed / 1000;
    }
    return null;
  }

  function timestampFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    for (const key of ['created_at', 'createdAt', 'created', 'sent_at', 'sentAt', 'ts', 't', 'timestamp']) {
      const ts = coerceTimestamp(payload[key]);
      if (ts != null) return ts;
    }
    for (const key of ['message', 'data', 'body']) {
      const nested = payload[key];
      if (nested && typeof nested === 'object') {
        const ts = timestampFromPayload(nested);
        if (ts != null) return ts;
      }
    }
    return null;
  }

  function isMatchAnimation(path) {
    return path.includes('/animations/announcement/match-start');
  }

  function isLikeCounterPath(path) {
    return path.replace(/\/+$/, '').endsWith('/search_likes/feed/counter');
  }

  function isLikeFeedPath(path) {
    return path.replace(/\/+$/, '').endsWith('/search_likes/feed');
  }

  function chatIdFromHistoryPath(path) {
    const match = String(path || '').match(/\/chats-service\/v\d+\/chats\/([^/]+)\/history\/?$/i);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function isChatHistoryPath(path) {
    return !!chatIdFromHistoryPath(path);
  }

  function chatIdFromChannel(channel) {
    const value = String(channel || '');
    const lower = value.toLowerCase();
    if (!value) return '';
    if (lower.includes('chat') || lower.includes('thread') || lower.includes('conversation') || lower.includes('room')) return value;
    return '';
  }

  function chatIdFromData(data) {
    if (!data || typeof data !== 'object') return '';
    const value = firstStringDeep(data, CHAT_ID_KEYS);
    return chatIdFromChannel(value) || value;
  }

  function extractText(data) {
    if (!data || typeof data !== 'object') return '';
    for (const key of MESSAGE_TEXT_KEYS) {
      const value = data[key];
      if (typeof value === 'string' && value) return value;
    }
    for (const key of MESSAGE_NESTED_KEYS) {
      const nested = data[key];
      if (!nested || typeof nested !== 'object') continue;
      for (const inner of MESSAGE_TEXT_KEYS) {
        const value = nested[inner];
        if (typeof value === 'string' && value) return value;
      }
    }
    return '';
  }

  function extractSender(data) {
    const direct = firstStringDeep(data, MESSAGE_SENDER_KEYS);
    if (direct) return direct;
    for (const key of ['author', 'sender', 'from']) {
      const nested = data && typeof data === 'object' ? data[key] : null;
      const value = firstString(nested, MESSAGE_SENDER_KEYS.concat(['id']));
      if (value) return value;
    }
    return '';
  }

  function buildMessage(chatId, data, source, raw, options = {}) {
    if (!chatId || !data || typeof data !== 'object') return null;
    const text = extractText(data);
    const sender = extractSender(data) || options.sender || '';
    const messageId = firstStringDeep(data, MESSAGE_ID_KEYS) || options.messageId || stableHash({chatId, text, sender, raw});
    let kind = (firstStringDeep(data, MESSAGE_KIND_KEYS) || options.kind || 'text').toLowerCase();
    const photoId = firstStringDeep(data, ['photo_id', 'photoId', 'p']);
    const photoAttachment = firstStringDeep(data, ['pa', 'photo_attachment', 'photoAttachment']);
    if ((!kind || kind === 'text') && (photoId || photoAttachment)) kind = 'photo';
    if (!MESSAGE_KINDS.has(kind)) return null;
    if (kind === 'text' && !text && !options.allowEmptyText) return null;
    if (kind === 'photo' && !photoId && !photoAttachment) return null;
    const dataTs = timestampFromPayload(data);
    return {
      threadId: chatId,
      messageId,
      text,
      sender,
      kind,
      ts: dataTs != null ? dataTs : options.ts || null,
      source
    };
  }

  function messageDataCandidates(data, depth = 0, out = []) {
    if (!data || typeof data !== 'object' || depth > 3) return out;
    if (!out.includes(data)) out.push(data);
    for (const key of MESSAGE_NESTED_KEYS.concat(['event', 'result', 'item'])) {
      const nested = data[key];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        messageDataCandidates(nested, depth + 1, out);
      }
    }
    return out;
  }

  function buildMessageFromCandidates(chatId, data, source, raw) {
    for (const candidate of messageDataCandidates(data)) {
      const msg = buildMessage(chatId, candidate, source, raw);
      if (msg) return msg;
    }
    return null;
  }

  function buildChatServiceEventMessage(frame, source) {
    const event = frame && typeof frame === 'object' && frame.event && typeof frame.event === 'object' ? frame.event : null;
    const chatId = chatIdFromChannel(frame && frame.channel) || chatIdFromData(event);
    if (!event || !chatId) return null;

    const history = event.h && typeof event.h === 'object' && event.h.m && typeof event.h.m === 'object' ? event.h.m : null;
    if (history) {
      return buildMessage(chatId, history, `${source}:history`, frame);
    }

    const kind = String(event.type || event.kind || '').toLowerCase();
    if (!MESSAGE_KINDS.has(kind)) return null;
    const sender = extractSender(event);
    if (!sender) return null;
    const ts = coerceTimestamp(event.t || event.ts);
    const messageId = firstStringDeep(event, MESSAGE_ID_KEYS) || stableHash({
      chatId,
      sender,
      kind,
      ts,
      source: 'chats-service-ws'
    });
    return buildMessage(chatId, event, source, frame, {
      allowEmptyText: true,
      kind,
      sender,
      ts,
      messageId
    });
  }

  function historyRows(body) {
    if (Array.isArray(body)) return body.filter(item => item && typeof item === 'object');
    if (!body || typeof body !== 'object') return [];
    for (const key of ['messages', 'items', 'results', 'data', 'history']) {
      const value = body[key];
      if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
    }
    return [];
  }

  function parseHistoryMessages(path, body) {
    if (!isChatHistoryPath(path)) return [];
    const fallbackChatId = chatIdFromHistoryPath(path);
    const messages = [];
    for (const row of historyRows(body)) {
      const chatId = chatIdFromData(row) || fallbackChatId;
      const msg = buildMessageFromCandidates(chatId, row, 'chat_history', row);
      if (msg) messages.push(msg);
    }
    return messages;
  }

  function parseIncomingMessage(frameText) {
    const body = safeJson(frameText);
    const frames = Array.isArray(body) ? body : [body];
    for (const frame of frames) {
      if (!frame || typeof frame !== 'object') continue;
      const chatService = buildChatServiceEventMessage(frame, 'chat_service_ws');
      if (chatService) return chatService;
      const push = frame.push;
      if (push && typeof push === 'object') {
        const pub = push.pub;
        const data = pub && typeof pub === 'object' ? pub.data : null;
        const chatId = chatIdFromChannel(push.channel) || chatIdFromData(data);
        const msg = buildMessageFromCandidates(chatId, data && typeof data === 'object' ? data : {}, 'ws_recv', frame);
        if (msg) return msg;
      }
      const pub = frame.pub;
      if (pub && typeof pub === 'object') {
        const data = pub.data;
        const chatId = chatIdFromChannel(frame.channel) || chatIdFromData(data);
        const msg = buildMessageFromCandidates(chatId, data && typeof data === 'object' ? data : {}, 'ws_recv', frame);
        if (msg) return msg;
      }
    }
    return null;
  }

  function outgoingCommands(body) {
    if (Array.isArray(body)) return body.filter(item => item && typeof item === 'object');
    if (body && typeof body === 'object') return [body];
    return [];
  }

  function parseOutgoingMessage(frameText) {
    const body = safeJson(frameText);
    for (const command of outgoingCommands(body)) {
      const chatService = buildChatServiceEventMessage(command, 'chat_service_ws_send');
      if (chatService) return chatService;
      const publish = command.publish;
      if (publish && typeof publish === 'object') {
        const data = publish.data && typeof publish.data === 'object' ? publish.data : {};
        const chatId = chatIdFromChannel(publish.channel) || chatIdFromData(data);
        const msg = buildMessageFromCandidates(chatId, data, 'publish', command);
        if (msg) return msg;
      }
      const rpc = command.rpc || command.send;
      if (rpc && typeof rpc === 'object') {
        const data = rpc.data && typeof rpc.data === 'object' ? rpc.data : {};
        const chatId = chatIdFromData(data);
        const msg = buildMessageFromCandidates(chatId, data, command.rpc ? 'rpc' : 'send', command);
        if (msg) return msg;
      }
    }
    return null;
  }

  function messageKey(message) {
    if (!message || !message.threadId) return '';
    return `${message.threadId}:${message.messageId || stableHash(message)}`;
  }

  function makeMatchSignal(dedupeKey, source, options = {}) {
    return {
      kind: 'match',
      dedupeKey,
      title: 'PureAutoLike',
      body: 'Новый мэтч в Pure',
      source,
      threadId: options.threadId || '',
      ts: options.ts || Date.now() / 1000
    };
  }

  function makeLikeSignal(dedupeKey, source, options = {}) {
    const count = options.count || 1;
    return {
      kind: 'like',
      dedupeKey,
      title: 'PureAutoLike',
      body: count <= 1 ? 'Новый лайк в Pure' : `Новых лайков в Pure: ${count}`,
      source,
      userId: options.userId || '',
      label: options.label || '',
      ts: options.ts || Date.now() / 1000
    };
  }

  function makeMessageSignal(dedupeKey, source, message, ts) {
    const body = message.kind && message.kind !== 'text' ? `Новое сообщение в Pure (${message.kind})` : 'Новое сообщение в Pure';
    return {
      kind: 'message',
      dedupeKey,
      title: 'PureAutoLike',
      body,
      source,
      userId: message.sender || '',
      threadId: message.threadId || '',
      text: message.text || '',
      messageKind: message.kind || 'text',
      ts: message.ts || ts || Date.now() / 1000
    };
  }

  function createEngagementDetector() {
    const state = {
      myUserId: '',
      lastLikeCount: null,
      likeFeedBaselined: false,
      seenLikeUserIds: new Set(),
      seenLikeUserQueue: [],
      seenMessageKeys: new Set(),
      seenMessageQueue: [],
      sentMessageKeys: new Set(),
      sentMessageQueue: [],
      historyBaselinedThreads: new Set(),
      historyBaselinedThreadQueue: [],
      emittedKeys: new Set(),
      emittedQueue: [],
      lastMatchTs: 0
    };

    function rememberLimited(set, queue, key, limit = NOTIFICATION_MEMORY_LIMIT) {
      if (!key || set.has(key)) return;
      set.add(key);
      queue.push(key);
      while (queue.length > limit) {
        set.delete(queue.shift());
      }
    }

    function fresh(signals) {
      const out = [];
      for (const signal of signals) {
        if (state.emittedKeys.has(signal.dedupeKey)) continue;
        if (signal.kind === 'match' && state.lastMatchTs && Math.abs((signal.ts || eventTs({})) - state.lastMatchTs) <= MATCH_DEDUP_SECONDS) continue;
        if (signal.kind === 'match') state.lastMatchTs = signal.ts || Date.now() / 1000;
        rememberLimited(state.emittedKeys, state.emittedQueue, signal.dedupeKey);
        out.push(signal);
      }
      return out;
    }

    function scanLikeResponse(event, path, body) {
      if (isLikeCounterPath(path)) {
        const count = extractCount(body);
        if (count == null) return [];
        const previous = state.lastLikeCount;
        state.lastLikeCount = count;
        if (previous == null || count <= previous) return [];
        return [makeLikeSignal(`like:counter:${count}:${Math.floor(eventTs(event) / 60)}`, 'search_likes_counter', {count: count - previous, ts: eventTs(event)})];
      }

      if (isLikeFeedPath(path)) {
        const profiles = extractLikeProfiles(body);
        const ids = new Set(profiles.map(profile => profile.userId).filter(Boolean));
        if (!state.likeFeedBaselined) {
          state.likeFeedBaselined = true;
          for (const id of ids) rememberLimited(state.seenLikeUserIds, state.seenLikeUserQueue, id);
          return [];
        }
        const freshProfiles = profiles.filter(profile => profile.userId && !state.seenLikeUserIds.has(profile.userId));
        for (const id of ids) rememberLimited(state.seenLikeUserIds, state.seenLikeUserQueue, id);
        if (!freshProfiles.length) return [];
        if (freshProfiles.length === 1) {
          const profile = freshProfiles[0];
          return [makeLikeSignal(`like:feed:${profile.userId}`, 'search_likes_feed', {userId: profile.userId, label: profile.label, ts: eventTs(event)})];
        }
        return [makeLikeSignal(`like:feed:${stableHash(freshProfiles.map(profile => profile.userId).sort())}`, 'search_likes_feed', {count: freshProfiles.length, ts: eventTs(event)})];
      }
      return [];
    }

    function matchFromChatResponse(event, path, body) {
      const method = String(event.method || '').toUpperCase();
      if (!['POST', 'PATCH'].includes(method)) return null;
      if (path.includes('/chats-service/') || !path.startsWith('/chats/')) return null;
      const payload = unwrapChat(body);
      if (!payload || typeof payload !== 'object') return null;
      const createdTs = timestampFromPayload(payload);
      if (createdTs == null || Math.abs(eventTs(event) - createdTs) > 30 * 60) return null;
      const id = threadId(payload) || stableHash(payload);
      return makeMatchSignal(`match:${id}`, 'chat_metadata', {threadId: id, ts: eventTs(event)});
    }

    function messageSignalFromMessage(message, source, ts) {
      const key = messageKey(message);
      if (!key || state.seenMessageKeys.has(key)) return null;
      rememberLimited(state.seenMessageKeys, state.seenMessageQueue, key);
      if (state.sentMessageKeys.has(key) || (state.myUserId && message.sender === state.myUserId)) return null;
      return makeMessageSignal(`message:${key}`, source, message, ts);
    }

    function historyThreadKey(message) {
      return String(message && message.threadId || '');
    }

    function rememberMessageSeen(message) {
      const key = messageKey(message);
      if (key) rememberLimited(state.seenMessageKeys, state.seenMessageQueue, key);
      return key;
    }

    function rememberHistoryThread(threadKey) {
      rememberLimited(state.historyBaselinedThreads, state.historyBaselinedThreadQueue, threadKey);
    }

    function initialHistoryThreads(messages) {
      const out = new Set();
      for (const message of messages) {
        const threadKey = historyThreadKey(message);
        if (threadKey && !state.historyBaselinedThreads.has(threadKey)) out.add(threadKey);
      }
      return out;
    }

    function recentHistoryMessage(event, message) {
      const ts = message && message.ts || 0;
      return !!ts && Math.abs(eventTs(event) - ts) <= HISTORY_MESSAGE_RECENCY_SECONDS;
    }

    function messageSignalFromHistory(event, message, source) {
      const threadKey = historyThreadKey(message);
      if (!recentHistoryMessage(event, message)) {
        rememberMessageSeen(message);
        if (threadKey) rememberHistoryThread(threadKey);
        return null;
      }
      if (threadKey && !state.historyBaselinedThreads.has(threadKey)) {
        rememberMessageSeen(message);
        rememberHistoryThread(threadKey);
        return null;
      }
      return messageSignalFromMessage(message, source, eventTs(event));
    }

    function scanMessageResponse(event, path, body) {
      const out = [];
      const messages = parseHistoryMessages(path, body);
      const baselineThreads = initialHistoryThreads(messages);
      for (const threadKey of baselineThreads) rememberHistoryThread(threadKey);
      for (const message of messages) {
        const key = messageKey(message);
        if (!key) continue;
        const threadKey = historyThreadKey(message);
        if (!recentHistoryMessage(event, message) || baselineThreads.has(threadKey)) {
          rememberMessageSeen(message);
          continue;
        }
        const signal = messageSignalFromMessage(message, 'chat_history', eventTs(event));
        if (signal) out.push(signal);
      }
      return out;
    }

    function scanResponse(event) {
      const path = pathOf(event.url);
      const signals = [];
      const status = Number(event.status || 0);
      if (isMatchAnimation(path) && (status === 200 || status === 304)) {
        signals.push(makeMatchSignal(`match:animation:${event.seq || Math.floor(eventTs(event))}`, 'match_animation', {ts: eventTs(event)}));
      }

      const bodyText = event.bodyText || event.body_text || '';
      const body = safeJson(bodyText);
      if (body != null) {
        signals.push(...scanLikeResponse(event, path, body));
        signals.push(...scanMessageResponse(event, path, body));
        const match = matchFromChatResponse(event, path, body);
        if (match) signals.push(match);
      }
      return signals;
    }

    function scanWs(event) {
      const payload = event.wsPayload || event.ws_payload || '';
      const body = safeJson(payload);
      const inner = getPushData(body);
      const signals = [];
      if (inner && typeof inner === 'object') {
        const moduleName = String(inner.module || '').toLowerCase();
        const action = String(inner.action || '').toLowerCase();
        const data = inner.data && typeof inner.data === 'object' ? inner.data : {};
        if ((moduleName === 'chat' || moduleName === 'chats') && MATCH_ACTIONS.has(action)) {
          const id = threadId(data) || stableHash(data || inner);
          signals.push(makeMatchSignal(`match:${id}`, `ws:${moduleName}:${action}`, {threadId: id, ts: eventTs(event)}));
        }
        if (LIKE_MODULES.has(moduleName) && LIKE_ACTIONS.has(action)) {
          const profile = profileFromDict(data);
          const id = profile ? profile.userId : stableHash(data || inner);
          signals.push(makeLikeSignal(`like:ws:${id}`, `ws:${moduleName}:${action}`, {
            userId: profile ? profile.userId : '',
            label: profile ? profile.label : '',
            ts: eventTs(event)
          }));
        }
      }

      const message = parseIncomingMessage(payload);
      if (message) {
        const source = message.source || 'ws_recv';
        const signal = source.includes(':history')
          ? messageSignalFromHistory(event, message, source)
          : messageSignalFromMessage(message, source, eventTs(event));
        if (signal) signals.push(signal);
      }
      return signals;
    }

    return {
      setMyUserId(value) {
        state.myUserId = value || state.myUserId;
      },
      scan(event) {
        const kind = String(event && event.kind || '');
        if (kind === 'ws_send') {
          const message = parseOutgoingMessage(event.wsPayload || event.ws_payload || '');
          const key = messageKey(message);
          if (key) {
            rememberLimited(state.sentMessageKeys, state.sentMessageQueue, key);
            rememberLimited(state.seenMessageKeys, state.seenMessageQueue, key);
          }
          return [];
        }
        if (kind === 'response') return fresh(scanResponse(event));
        if (kind === 'ws_recv') return fresh(scanWs(event));
        return [];
      }
    };
  }

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

  async function notifyTelegram(signal) {
    runtime.telegramLastEvent = {kind: signal.kind, source: signal.source, ts: Date.now()};
    runtime.telegramLastError = '';
    const response = await sendRuntime({
      type: 'pal-telegram-event',
      signal: {
        kind: signal.kind,
        dedupeKey: signal.dedupeKey,
        title: signal.title || 'PureAutoLike',
        body: signal.body || 'Новое событие в Pure',
        source: signal.source || '',
        text: signal.text || '',
        label: signal.label || ''
      }
    });
    if (response && response.ok) {
      runtime.telegramConfigured = !!response.configured;
      runtime.telegramSent = Number(response.sent) || runtime.telegramSent;
      runtime.telegramLastEvent = response.lastEvent || runtime.telegramLastEvent;
      return;
    }
    runtime.telegramLastError = response && response.error ? response.error : 'Telegram send failed';
  }

  function handleNetEvent(event) {
    if (!runtime.engagementDetector || !event || typeof event !== 'object') return;
    runtime.diagnostics.lastNetEventAt = new Date().toISOString();
    runtime.diagnostics.lastNetEventKind = String(event.kind || '');
    runtime.diagnostics.lastNetEventUrl = String(event.url || '').slice(0, 160);
    for (const signal of runtime.engagementDetector.scan(event)) {
      void notifyTelegram(signal);
    }
  }

  async function clickLike(candidate, options = {}) {
    if (!candidate.el || !candidate.el.isConnected) return false;
    candidate.el.scrollIntoView({block: 'center', inline: 'center', behavior: 'auto'});
    await nextFrame();
    if (!isVisible(candidate.el)) return false;
    const before = snapshot(candidate.el);
    if (!before) return false;
    const rect = candidate.el.getBoundingClientRect();
    const box = {x: rect.left, y: rect.top, width: rect.width, height: rect.height};
    const point = options.forceCenter ? centerPoint(box) : jitteredPoint(box);
    if (!pointTargetsButton(candidate.el, point)) return false;

    if (runtime.settings.useDebugger) {
      const response = await sendRuntime({
        type: 'pal-debugger-click',
        point,
        options: {humanize: runtime.settings.humanizeMouse}
      });
      if (!response.ok) {
        if (response.unsupported) runtime.capabilities = {...runtime.capabilities, debugger: false, clickMode: 'dom'};
        runtime.settings.useDebugger = false;
        candidate.el.click();
      }
      return confirmReaction(candidate.el, before, options.confirmMs || CLICK_CONFIRM_MS);
    }

    candidate.el.click();
    return confirmReaction(candidate.el, before, options.confirmMs || CLICK_CONFIRM_MS);
  }

  async function retryClickLike(candidate) {
    await sleep(80);
    closeBlockingOverlays();
    if (!runtime.running || !runtime.settings.enabled) return false;
    if (runtime.seen.has(candidate.signature)) return true;
    return clickLike(candidate, {forceCenter: true, confirmMs: CLICK_RETRY_CONFIRM_MS});
  }

  function rememberSeen(signature) {
    if (!signature || runtime.seen.has(signature)) return;
    runtime.seen.add(signature);
    runtime.clickMisses.delete(signature);
    runtime.seenQueue.push(signature);
    while (runtime.seenQueue.length > SEEN_SIGNATURE_LIMIT) {
      runtime.seen.delete(runtime.seenQueue.shift());
    }
  }

  function profileChunkKey(index) {
    return `${PROFILE_CAPTURE_CHUNK_PREFIX}${index}`;
  }

  function estimateJsonBytes(value) {
    try {
      return new Blob([JSON.stringify(value)]).size;
    } catch (_) {
      return JSON.stringify(value || '').length;
    }
  }

  async function storedProfileChunkKeys() {
    const data = await storageGet({[PROFILE_CAPTURE_INDEX_KEY]: null});
    const index = data[PROFILE_CAPTURE_INDEX_KEY];
    return index && Array.isArray(index.chunks) ? index.chunks.filter(Boolean) : [];
  }

  function chunkProfiles(profiles) {
    const chunks = [];
    for (let i = 0; i < profiles.length; i += PROFILE_CAPTURE_CHUNK_SIZE) {
      chunks.push(profiles.slice(i, i + PROFILE_CAPTURE_CHUNK_SIZE));
    }
    return chunks;
  }

  function profileStorageStats(profiles, chunks) {
    return {
      mode: chunks && chunks.length ? 'chunked' : 'empty',
      count: profiles.length,
      chunks: chunks ? chunks.length : 0,
      bytes: estimateJsonBytes(profiles)
    };
  }

  async function readStoredProfileSummary() {
    const data = await storageGet({[PROFILE_CAPTURE_INDEX_KEY]: null, [PROFILE_CAPTURE_KEY]: []});
    const index = data[PROFILE_CAPTURE_INDEX_KEY];
    if (index && Array.isArray(index.chunks)) {
      return {
        mode: index.chunks.length ? 'chunked' : 'empty',
        count: Number(index.count) || 0,
        chunks: index.chunks.length,
        bytes: Number(index.bytes) || 0
      };
    }
    const legacy = normalizeStoredProfiles(data[PROFILE_CAPTURE_KEY]);
    return {
      mode: legacy.length ? 'legacy' : 'empty',
      count: legacy.length,
      chunks: 0,
      bytes: estimateJsonBytes(legacy)
    };
  }

  async function loadProfileCaptureSummary() {
    runtime.profileCaptureStorage = await readStoredProfileSummary();
    runtime.profileCaptureStoredCount = runtime.profileCaptureStorage.count || 0;
    if (runtime.sessionStatsLoaded) updateSessionStats({profileCaptureCount: runtime.profileCaptureStorage.count || 0});
    return runtime.profileCaptureStorage;
  }

  async function readStoredProfiles() {
    const data = await storageGet({[PROFILE_CAPTURE_INDEX_KEY]: null, [PROFILE_CAPTURE_KEY]: []});
    const index = data[PROFILE_CAPTURE_INDEX_KEY];
    if (index && Array.isArray(index.chunks) && index.chunks.length) {
      const defaults = {};
      for (const key of index.chunks) defaults[key] = [];
      const chunkData = await storageGet(defaults);
      const profiles = [];
      for (const key of index.chunks) {
        if (Array.isArray(chunkData[key])) profiles.push(...chunkData[key]);
      }
      const normalized = normalizeStoredProfiles(profiles);
      runtime.profileCaptureStorage = profileStorageStats(normalized, index.chunks);
      return normalized;
    }
    const legacy = normalizeStoredProfiles(data[PROFILE_CAPTURE_KEY]);
    runtime.profileCaptureStorage = {
      mode: legacy.length ? 'legacy' : 'empty',
      count: legacy.length,
      chunks: 0,
      bytes: estimateJsonBytes(legacy)
    };
    return legacy;
  }

  async function appendStoredProfiles(normalized, index, oldChunkKeys) {
    const storedCount = Math.max(0, Math.min(normalized.length, Number(index && index.count) || runtime.profileCaptureStoredCount || 0));
    const append = normalized.slice(storedCount);
    const chunks = oldChunkKeys.slice();
    const payload = {[PROFILE_CAPTURE_KEY]: []};
    let pending = append.slice();

    if (pending.length && chunks.length) {
      const lastKey = chunks[chunks.length - 1];
      const chunkData = await storageGet({[lastKey]: []});
      const lastChunk = normalizeStoredProfiles(Array.isArray(chunkData[lastKey]) ? chunkData[lastKey] : []);
      const room = Math.max(0, PROFILE_CAPTURE_CHUNK_SIZE - lastChunk.length);
      if (room > 0) {
        lastChunk.push(...pending.splice(0, room));
        payload[lastKey] = lastChunk;
      }
    }

    while (pending.length) {
      const key = profileChunkKey(chunks.length);
      const chunk = pending.splice(0, PROFILE_CAPTURE_CHUNK_SIZE);
      chunks.push(key);
      payload[key] = chunk;
    }

    payload[PROFILE_CAPTURE_INDEX_KEY] = {
      version: 1,
      count: normalized.length,
      bytes: estimateJsonBytes(normalized),
      chunkSize: PROFILE_CAPTURE_CHUNK_SIZE,
      chunks,
      updatedAt: new Date().toISOString()
    };
    await storageSet(payload);
    runtime.profileCaptureStoredCount = normalized.length;
    runtime.profileCaptureStorage = profileStorageStats(normalized, chunks);
  }

  async function rewriteStoredProfiles(normalized, oldChunkKeys) {
    const chunks = chunkProfiles(normalized);
    const bytes = estimateJsonBytes(normalized);
    const payload = {
      [PROFILE_CAPTURE_KEY]: [],
      [PROFILE_CAPTURE_INDEX_KEY]: {
        version: 1,
        count: normalized.length,
        bytes,
        chunkSize: PROFILE_CAPTURE_CHUNK_SIZE,
        chunks: chunks.map((_, index) => profileChunkKey(index)),
        updatedAt: new Date().toISOString()
      }
    };
    chunks.forEach((chunk, index) => {
      payload[profileChunkKey(index)] = chunk;
    });
    const nextKeys = new Set(payload[PROFILE_CAPTURE_INDEX_KEY].chunks);
    const removeKeys = oldChunkKeys.filter(key => !nextKeys.has(key));
    if (removeKeys.length) await storageRemove(removeKeys);
    await storageSet(payload);
    runtime.profileCaptureStoredCount = normalized.length;
    runtime.profileCaptureStorage = profileStorageStats(normalized, payload[PROFILE_CAPTURE_INDEX_KEY].chunks);
  }

  async function writeStoredProfiles(profiles) {
    const normalized = normalizeStoredProfiles(profiles);
    const data = await storageGet({[PROFILE_CAPTURE_INDEX_KEY]: null});
    const index = data[PROFILE_CAPTURE_INDEX_KEY];
    const oldChunkKeys = index && Array.isArray(index.chunks) ? index.chunks.filter(Boolean) : [];
    const canAppend = oldChunkKeys.length && Number(index.count) >= 0 && Number(index.count) <= normalized.length;
    if (canAppend) {
      await appendStoredProfiles(normalized, index, oldChunkKeys);
      return;
    }
    await rewriteStoredProfiles(normalized, oldChunkKeys);
  }

  async function clearStoredProfiles() {
    const oldChunkKeys = await storedProfileChunkKeys();
    if (oldChunkKeys.length) await storageRemove(oldChunkKeys);
    await storageSet({
      [PROFILE_CAPTURE_KEY]: [],
      [PROFILE_CAPTURE_INDEX_KEY]: {
        version: 1,
        count: 0,
        bytes: 0,
        chunkSize: PROFILE_CAPTURE_CHUNK_SIZE,
        chunks: [],
        updatedAt: new Date().toISOString()
      }
    });
    runtime.profileCaptureStorage = profileStorageStats([], []);
    runtime.profileCaptureStoredCount = 0;
  }

  function normalizeStoredProfiles(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const sourceText = String(item.rawText || item.description || item.text || '').slice(0, PROFILE_CAPTURE_TEXT_LIMIT);
        const parsed = profileFieldsFromText(sourceText);
        const description = String(item.description || item.text || parsed.description || '').slice(0, PROFILE_CAPTURE_TEXT_LIMIT);
        const descriptionKey = String(item.descriptionKey || parsed.descriptionKey || descriptionKeyForText(description));
        return {
          key: String(item.key || item.signature || ''),
          signature: String(item.signature || ''),
          label: String(item.label || ''),
          status: String(item.status || parsed.status || ''),
          age: String(item.age || parsed.age || ''),
          description,
          descriptionKey,
          rawText: String(item.rawText || parsed.rawText || description).slice(0, PROFILE_CAPTURE_TEXT_LIMIT),
          capturedAt: String(item.capturedAt || ''),
          sessionLikes: Number.isFinite(Number(item.sessionLikes)) ? Number(item.sessionLikes) : null,
          url: String(item.url || '')
        };
      })
      .filter(item => item.description);
  }

  async function loadProfileCaptures() {
    if (runtime.profileCaptureLoaded) return;
    try {
      runtime.profileCaptures = await readStoredProfiles();
      runtime.profileCaptureSeen = new Set(runtime.profileCaptures.map(item => item.key || item.signature).filter(Boolean));
      runtime.profileCaptureDescriptionSeen = new Set(runtime.profileCaptures.map(item => item.descriptionKey).filter(Boolean));
      runtime.profileCaptureLoaded = true;
      runtime.profileCaptureStoredCount = runtime.profileCaptures.length;
      runtime.profileCaptureLastError = '';
      if (runtime.sessionStatsLoaded) updateSessionStats({profileCaptureCount: runtime.profileCaptures.length});
    } catch (error) {
      runtime.profileCaptureLoaded = true;
      runtime.profileCaptureLastError = error.message || String(error);
    }
  }

  function scheduleProfileCaptureFlush() {
    if (runtime.profileCaptureFlushTimer) return;
    runtime.profileCaptureFlushTimer = window.setTimeout(() => {
      runtime.profileCaptureFlushTimer = 0;
      void flushProfileCaptures();
    }, 900);
  }

  async function flushProfileCaptures() {
    clearTimeout(runtime.profileCaptureFlushTimer);
    runtime.profileCaptureFlushTimer = 0;
    if (!runtime.profileCaptureLoaded) {
      if (!runtime.profileCaptureDirty) {
        await loadProfileCaptureSummary();
        return {ok: true, count: runtime.profileCaptureStorage.count || 0};
      }
      await loadProfileCaptures();
    }
    if (!runtime.profileCaptureDirty) {
      return {ok: true, count: runtime.profileCaptures.length};
    }
    try {
      await writeStoredProfiles(runtime.profileCaptures);
      runtime.profileCaptureDirty = false;
      runtime.profileCaptureLastError = '';
      return {ok: true, count: runtime.profileCaptures.length};
    } catch (error) {
      runtime.profileCaptureLastError = error.message || String(error);
      return {ok: false, count: runtime.profileCaptures.length, error: runtime.profileCaptureLastError};
    }
  }

  async function clearProfileCaptures() {
    clearTimeout(runtime.profileCaptureFlushTimer);
    runtime.profileCaptureFlushTimer = 0;
    runtime.profileCaptures = [];
    runtime.profileCaptureSeen = new Set();
    runtime.profileCaptureDescriptionSeen = new Set();
    runtime.profileCaptureDirty = false;
    runtime.profileCaptureLoaded = true;
    runtime.profileCaptureStoredCount = 0;
    runtime.profileCaptureLastError = '';
    await clearStoredProfiles();
    updateSessionStats({profileCaptureCount: 0, lastProfileCaptureAt: ''});
  }

  function captureKeyForCandidate(candidate, description) {
    if (candidate.signature && !String(candidate.signature).startsWith('none:')) return candidate.signature;
    if (candidate.hashes && candidate.hashes.length) return `img:${candidate.hashes.slice().sort().join('|')}`;
    return `txt:${stableHash(description)}`;
  }

  function captureProfile(candidate) {
    if (!runtime.settings.profileCaptureEnabled) return;
    if (!runtime.profileCaptureLoaded) return;
    const profile = candidate.profile || profileFieldsFromText(candidate.description || candidate.label || '');
    const description = String(profile.description || candidate.description || candidate.label || '').trim();
    if (description.length < 12) return;
    const descriptionKey = profile.descriptionKey || descriptionKeyForText(description);
    const key = captureKeyForCandidate(candidate, description);
    if (runtime.profileCaptureSeen.has(key)) return;
    if (descriptionKey && runtime.profileCaptureDescriptionSeen.has(descriptionKey)) return;
    runtime.profileCaptureSeen.add(key);
    if (descriptionKey) runtime.profileCaptureDescriptionSeen.add(descriptionKey);
    runtime.profileCaptures.push({
      key,
      signature: candidate.signature || '',
      label: candidate.label || '',
      status: profile.status || '',
      age: profile.age || '',
      description: description.slice(0, PROFILE_CAPTURE_TEXT_LIMIT),
      descriptionKey,
      rawText: profile.rawText || '',
      capturedAt: new Date().toISOString(),
      sessionLikes: runtime.likes,
      url: location.href
    });
    runtime.profileCaptureDirty = true;
    updateSessionStats({
      lastProfileCaptureAt: runtime.profileCaptures[runtime.profileCaptures.length - 1].capturedAt,
      profileCaptureCount: runtime.profileCaptures.length
    });
    scheduleProfileCaptureFlush();
  }

  function captureVisibleProfiles() {
    if (!runtime.settings.profileCaptureEnabled || !runtime.profileCaptureLoaded) return {captured: 0, visible: 0};
    const cards = visibleProfileCardElements();
    let captured = 0;
    for (const card of cards) {
      const candidate = profileCandidateFromCard(card);
      if (!candidate) continue;
      const before = runtime.profileCaptures.length;
      captureProfile(candidate);
      if (runtime.profileCaptures.length > before) captured += 1;
    }
    return {captured, visible: cards.length};
  }

  function startRunnerHeartbeat() {
    clearInterval(runtime.runnerHeartbeatTimer);
    runtime.runnerHeartbeatTimer = window.setInterval(async () => {
      if (!runtime.runnerLock) return;
      const response = await sendRuntime({type: 'pal-runner-heartbeat'});
      if (response && response.ok) {
        runtime.runnerOwner = response.owner || runtime.runnerOwner;
        runtime.diagnostics.lastHeartbeatAt = new Date().toISOString();
        return;
      }
      runtime.lastError = response && response.error ? response.error : 'runner lock lost';
      runtime.runnerLock = false;
      runtime.runnerOwner = response && response.owner ? response.owner : null;
      runtime.running = false;
      clearTimeout(runtime.loopTimer);
      clearInterval(runtime.runnerHeartbeatTimer);
      updateBadge();
      await sendRuntime({type: 'pal-debugger-detach'});
    }, 5000);
  }

  async function claimRunnerLock() {
    const response = await sendRuntime({type: 'pal-runner-claim'});
    if (response && response.ok) {
      runtime.runnerLock = true;
      runtime.runnerOwner = response.owner || null;
      runtime.lastError = runtime.lastError === 'Автолайкер уже работает в другой вкладке Pure' ? '' : runtime.lastError;
      startRunnerHeartbeat();
      return true;
    }
    runtime.runnerLock = false;
    runtime.runnerOwner = response && response.owner ? response.owner : null;
    runtime.lastError = response && response.error ? response.error : 'Автолайкер уже работает в другой вкладке Pure';
    updateBadge();
    return false;
  }

  async function releaseRunnerLock() {
    clearInterval(runtime.runnerHeartbeatTimer);
    runtime.runnerHeartbeatTimer = 0;
    if (!runtime.runnerLock) return;
    runtime.runnerLock = false;
    runtime.runnerOwner = null;
    await sendRuntime({type: 'pal-runner-release'});
  }

  function clearAutoStopTimer() {
    clearTimeout(runtime.autoStopTimer);
    runtime.autoStopTimer = 0;
    runtime.timerDeadlines.autoStopAt = '';
  }

  function clearCloseTabTimer() {
    clearTimeout(runtime.closeTabTimer);
    runtime.closeTabTimer = 0;
    runtime.timerDeadlines.closeTabAt = '';
  }

  function clearLocalRunTimers() {
    clearAutoStopTimer();
    clearCloseTabTimer();
  }

  function clearRunTimers(options = {}) {
    if (options.keepClose) clearAutoStopTimer();
    else clearLocalRunTimers();
    if (!options.keepClose) runtime.timerMode = 'content';
    if (options.localOnly) return;
    void sendRuntime({type: 'pal-runner-timers-clear', keepClose: !!options.keepClose});
  }

  function timerDelay(minutes) {
    const ms = normalizeTimerMinutes(minutes) * 60000;
    return ms > 0 ? Math.min(ms, MAX_TIMER_MS) : 0;
  }

  function scheduleContentRunTimers() {
    clearLocalRunTimers();
    runtime.timerMode = 'content';
    if (!runtime.running || !runtime.settings.enabled) return;
    const now = Date.now();
    const autoStopDelay = timerDelay(runtime.settings.autoStopMinutes);
    if (autoStopDelay) {
      runtime.timerDeadlines.autoStopAt = new Date(now + autoStopDelay).toISOString();
      runtime.autoStopTimer = window.setTimeout(() => {
        runtime.autoStopTimer = 0;
        void stopByTimer();
      }, autoStopDelay);
    }
    const closeTabDelay = timerDelay(runtime.settings.closeTabMinutes);
    if (closeTabDelay) {
      runtime.timerDeadlines.closeTabAt = new Date(now + closeTabDelay).toISOString();
      runtime.closeTabTimer = window.setTimeout(() => {
        runtime.closeTabTimer = 0;
        void closeTabByTimer();
      }, closeTabDelay);
    }
  }

  async function scheduleRunTimers() {
    clearLocalRunTimers();
    if (!runtime.running || !runtime.settings.enabled) {
      clearRunTimers();
      return;
    }
    try {
      const response = await sendRuntime({
        type: 'pal-runner-timers-set',
        settings: {
          autoStopMinutes: runtime.settings.autoStopMinutes,
          closeTabMinutes: runtime.settings.closeTabMinutes
        }
      });
      if (response && response.ok && response.timers) {
        runtime.timerMode = response.mode || 'background';
        runtime.timerDeadlines.autoStopAt = response.timers.autoStopAt || '';
        runtime.timerDeadlines.closeTabAt = response.timers.closeTabAt || '';
        return;
      }
    } catch (_) {}
    scheduleContentRunTimers();
  }

  async function disableFromTimer(message, options = {}) {
    runtime.lastError = message;
    runtime.timerStopInProgress = true;
    try {
      await storageSet({enabled: false});
      await stopLiker(options);
    } finally {
      runtime.timerStopInProgress = false;
    }
  }

  async function stopByTimer() {
    await disableFromTimer('Таймер остановил автолайкер', {clearTimers: false, localOnly: true});
  }

  async function closeTabByTimer() {
    await disableFromTimer('Таймер закрывает вкладку Pure');
    await sendRuntime({type: 'pal-close-tab'});
  }

  function closeBlockingOverlays() {
    if (/\/feed(?:[/?#]|$)/.test(location.pathname) === false && location.pathname.includes('/app/')) {
      history.back();
    }
    const text = document.body ? document.body.innerText || '' : '';
    if (/СТАНЬ\s+ЦАР[ЕЁ]М|БЕРИ\s+\d+.*КОРОН/i.test(text)) {
      document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
      for (const btn of document.querySelectorAll('button,[role="button"]')) {
        const label = buttonLabel(btn);
        if (label === '×' || label === 'x' || label.includes('закрыть')) {
          try { btn.click(); } catch (_) {}
        }
      }
    }
  }

  async function processVisible() {
    let likedAny = false;
    let attempted = 0;
    let holdViewport = false;
    const profileCapture = captureVisibleProfiles();
    const candidates = detectLikeButtons();
    runtime.diagnostics.lastTickAt = new Date().toISOString();
    runtime.diagnostics.lastVisibleProfiles = profileCapture.visible;
    runtime.diagnostics.lastLikeTargets = candidates.length;
    for (const candidate of candidates) {
      if (!runtime.running || !runtime.settings.enabled) break;
      if (runtime.settings.sessionLimit > 0 && runtime.likes >= runtime.settings.sessionLimit) {
        await stopLiker();
        break;
      }
      if (runtime.seen.has(candidate.signature)) continue;
      attempted += 1;
      captureProfile(candidate);

      try {
        let ok = await clickLike(candidate);
        if (!ok) ok = await retryClickLike(candidate);
        if (ok) {
          rememberSeen(candidate.signature);
          runtime.likes += 1;
          likedAny = true;
          if (runtime.lastError === 'click not confirmed') runtime.lastError = '';
          updateSessionStats({lastTickAt: runtime.diagnostics.lastTickAt, profileCaptureCount: runtime.profileCaptures.length});
          updateBadge();
          await sleep(20);
        } else {
          runtime.failures += 1;
          updateSessionStats({lastTickAt: runtime.diagnostics.lastTickAt});
          const misses = (runtime.clickMisses.get(candidate.signature) || 0) + 1;
          runtime.clickMisses.set(candidate.signature, misses);
          if (misses < CLICK_MISS_HOLD_LIMIT) holdViewport = true;
          runtime.lastError = 'click not confirmed';
        }
      } catch (error) {
        runtime.failures += 1;
        updateSessionStats({lastTickAt: runtime.diagnostics.lastTickAt});
        runtime.lastError = error.message || String(error);
        if (runtime.settings.useDebugger && /Another debugger|debuggee|attach/i.test(runtime.lastError)) {
          runtime.settings.useDebugger = false;
        }
      }
    }
    runtime.diagnostics.lastAttempted = attempted;
    return {likedAny, foundAny: candidates.length > 0, attempted, holdViewport};
  }

  async function likerLoop() {
    if (!runtime.running) return;
    closeBlockingOverlays();
    const result = await processVisible();
    if (!runtime.running) return;
    if (result.likedAny) {
      runtime.loopTimer = window.setTimeout(likerLoop, 35);
      return;
    }
    if (result.holdViewport) {
      runtime.loopTimer = window.setTimeout(likerLoop, 55);
      return;
    }
    if (!result.foundAny) {
      await sleep(EMPTY_RENDER_GRACE_MS);
      const settled = await processVisible();
      if (!runtime.running) return;
      if (settled.likedAny) {
        runtime.loopTimer = window.setTimeout(likerLoop, 35);
        return;
      }
      if (settled.holdViewport) {
        runtime.loopTimer = window.setTimeout(likerLoop, 55);
        return;
      }
    }
    scrollFeed();
    runtime.loopTimer = window.setTimeout(likerLoop, 85);
  }

  async function startLiker(options = {}) {
    if (runtime.running || runtime.starting) return;
    runtime.starting = true;
    await loadSessionStats();
    if (options.resetStats) await resetSessionStats();
    else if (!runtime.sessionStats.startedAt) {
      const now = new Date().toISOString();
      runtime.sessionStats.startedAt = now;
      runtime.sessionStats.updatedAt = now;
      runtime.sessionStatsDirty = true;
      scheduleSessionStatsFlush();
    }
    if (runtime.settings.profileCaptureEnabled) await loadProfileCaptures();
    else await loadProfileCaptureSummary();
    const claimed = await claimRunnerLock();
    runtime.starting = false;
    if (!claimed) return;
    runtime.running = true;
    runtime.lastError = '';
    await scheduleRunTimers();
    updateBadge();
    likerLoop();
  }

  async function stopLiker(options = {}) {
    runtime.running = false;
    runtime.starting = false;
    clearTimeout(runtime.loopTimer);
    if (options.clearTimers === false) {
      clearAutoStopTimer();
      clearRunTimers({keepClose: true, localOnly: !!options.localOnly});
    } else {
      clearRunTimers({localOnly: !!options.localOnly});
    }
    await releaseRunnerLock();
    await flushSessionStats();
    await flushProfileCaptures();
    updateBadge();
    await sendRuntime({type: 'pal-debugger-detach'});
  }

  function rectIsUsable(rect) {
    return rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function mediaUrl(el) {
    return String(el.currentSrc || el.src || el.href?.baseVal || el.getAttribute('src') || el.getAttribute('href') || '');
  }

  function logoCandidateScore(el, rect) {
    if (!rectIsUsable(rect)) return -1;
    if (rect.left > 112 || rect.top > innerHeight * 0.42) return -1;
    if (rect.width < 28 || rect.width > 128 || rect.height < 24 || rect.height > 96) return -1;
    const text = norm(`${el.alt || ''} ${el.title || ''} ${el.getAttribute('aria-label') || ''} ${mediaUrl(el)}`).toLowerCase();
    let score = 1000 - rect.top * 2 - rect.left;
    if (text.includes('pure')) score += 450;
    if (/(logo|brand|favicon)/i.test(text)) score += 220;
    if (rect.left < 16) score += 120;
    if (rect.top < 220) score += 90;
    return score;
  }

  function findLogoBadgeAnchorRect() {
    let best = null;
    let bestScore = -1;

    for (const el of document.querySelectorAll('img,svg,picture,canvas')) {
      const rect = el.getBoundingClientRect();
      const score = logoCandidateScore(el, rect);
      if (score > bestScore) {
        best = rect;
        bestScore = score;
      }
    }

    for (const el of document.querySelectorAll('a,button,div,span')) {
      const rect = el.getBoundingClientRect();
      if (!rectIsUsable(rect)) continue;
      if (rect.left > 96 || rect.top > innerHeight * 0.38) continue;
      if (rect.width < 36 || rect.width > 120 || rect.height < 28 || rect.height > 88) continue;
      const style = getComputedStyle(el);
      const hasImage = style.backgroundImage && style.backgroundImage !== 'none';
      const text = norm(`${el.getAttribute('aria-label') || ''} ${el.title || ''} ${style.backgroundImage || ''}`).toLowerCase();
      if (!hasImage && !text.includes('pure')) continue;
      const score = logoCandidateScore(el, rect) + (hasImage ? 180 : 0);
      if (score > bestScore) {
        best = rect;
        bestScore = score;
      }
    }

    return bestScore >= 360 ? best : null;
  }

  function findBadgeAnchorRect() {
    const logo = findLogoBadgeAnchorRect();
    if (logo) return {rect: logo, kind: 'logo'};

    const media = document.querySelectorAll('img,svg');
    for (const el of media) {
      const rect = el.getBoundingClientRect();
      if (!rectIsUsable(rect)) continue;
      if (rect.left > 140 || rect.top < 48 || rect.top > Math.min(260, innerHeight * 0.32)) continue;
      if (rect.width < 24 || rect.width > 128 || rect.height < 24 || rect.height > 128) continue;
      return {rect, kind: 'media'};
    }

    let best = null;
    let bestScore = -1;
    for (const el of document.querySelectorAll('aside,nav,section,div')) {
      const rect = el.getBoundingClientRect();
      if (!rectIsUsable(rect)) continue;
      if (rect.left > 80 || rect.width < 180 || rect.width > 540 || rect.height < 240) continue;
      if (rect.top > innerHeight * 0.55) continue;
      const hasBrandMedia = !!el.querySelector('img,svg');
      const score = (hasBrandMedia ? 1000 : 0) + Math.max(0, 280 - Math.abs(rect.top - 180)) + Math.min(rect.width, 520);
      if (score > bestScore) {
        best = rect;
        bestScore = score;
      }
    }
    return best ? {rect: best, kind: 'region'} : null;
  }

  function positionBadge(badge) {
    const now = performance.now();
    if (now - runtime.badgePositionAt < 350) return;
    runtime.badgePositionAt = now;

    const anchor = findBadgeAnchorRect();
    const width = Math.max(152, badge.offsetWidth || 172);
    const height = Math.max(28, badge.offsetHeight || 30);
    let left = 14;
    let top = 120;

    if (anchor) {
      const rect = anchor.rect || anchor;
      if (anchor.kind === 'logo' || (rect.width <= 140 && rect.height <= 140)) {
        left = rect.right + 8;
        top = rect.top + (rect.height - height) / 2;
      } else {
        left = rect.left + 14;
        top = rect.top + 12;
      }
    }

    badge.style.setProperty('--pal-badge-left', `${Math.round(clamp(left, 8, innerWidth - width - 8))}px`);
    badge.style.setProperty('--pal-badge-top', `${Math.round(clamp(top, 8, innerHeight - height - 8))}px`);
  }

  function createBadge() {
    const badge = document.createElement('div');
    badge.className = 'pal-badge';
    badge.setAttribute('aria-hidden', 'true');

    const dot = document.createElement('span');
    dot.className = 'pal-badge-dot';
    const label = document.createElement('span');
    label.className = 'pal-badge-label';
    label.textContent = 'AutoLike';
    const count = document.createElement('span');
    count.className = 'pal-badge-count';
    const lock = document.createElement('span');
    lock.className = 'pal-badge-lock';
    lock.textContent = 'LOCK';

    badge.append(dot, label, count, lock);
    document.documentElement.appendChild(badge);
    return badge;
  }

  function updateBadge() {
    let badge = document.querySelector('.pal-badge');
    if (!badge) badge = createBadge();
    badge.dataset.running = runtime.running ? '1' : '0';
    badge.dataset.locked = runtime.runnerLock ? '1' : '0';
    badge.dataset.token = runtime.hasToken ? '1' : '0';
    const count = badge.querySelector('.pal-badge-count');
    if (count) count.textContent = String(runtime.likes);
    badge.title = `PureAutoLike: ${runtime.running ? 'работает' : 'готов'}; лайков ${runtime.likes}; сессия ${runtime.hasToken ? 'OK' : '-'}`;
    positionBadge(badge);
  }

  function refreshBadgePosition() {
    const badge = document.querySelector('.pal-badge');
    if (!badge) return;
    runtime.badgePositionAt = 0;
    positionBadge(badge);
  }

  function showToast(text) {
    let toast = document.querySelector('.pal-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'pal-toast';
      document.documentElement.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 4500);
  }

  function openViewerShell() {
    let viewer = null;
    try {
      viewer = window.open('', '_blank');
      if (viewer && viewer.document) {
        viewer.document.open();
        viewer.document.write('<!doctype html><html><head><meta charset="utf-8"><title>PureAutoLike photo</title><style>html,body{margin:0;width:100%;height:100%;background:#070707;color:#bbb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}body{display:grid;place-items:center}</style></head><body>Загрузка фото...</body></html>');
        viewer.document.close();
      }
    } catch (_) {
      viewer = null;
    }
    return viewer;
  }

  function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[char]);
  }

  function renderViewerMessage(viewer, text) {
    if (!viewer || viewer.closed) return;
    try {
      viewer.document.open();
      viewer.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>PureAutoLike photo</title><style>html,body{margin:0;width:100%;height:100%;background:#070707;color:#bbb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}body{display:grid;place-items:center;text-align:center;padding:24px;box-sizing:border-box}</style></head><body>${escapeHtml(text || 'Не удалось открыть фото')}</body></html>`);
      viewer.document.close();
      viewer.focus();
    } catch (_) {}
  }

  function showInlineViewer(blobUrl) {
    const old = document.querySelector('.pal-inline-viewer');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.className = 'pal-inline-viewer';
    const img = document.createElement('img');
    img.src = blobUrl;
    const close = document.createElement('button');
    close.textContent = '×';
    const remove = () => wrap.remove();
    wrap.onclick = remove;
    close.onclick = remove;
    img.onclick = event => event.stopPropagation();
    wrap.appendChild(img);
    wrap.appendChild(close);
    document.documentElement.appendChild(wrap);
  }

  function renderPhotoBlob(blobUrl, viewer) {
    if (viewer && !viewer.closed) {
      try {
        viewer.document.open();
        viewer.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>PureAutoLike photo</title><style>html,body{margin:0;width:100%;height:100%;background:#070707}body{display:grid;place-items:center}img{max-width:100vw;max-height:100vh;object-fit:contain}</style></head><body><img src="${blobUrl}" alt=""></body></html>`);
        viewer.document.close();
        viewer.focus();
        return;
      } catch (_) {}
    }
    showInlineViewer(blobUrl);
  }

  function rememberPhotoBlob(photoId, blobUrl) {
    const key = String(photoId || '');
    if (!key || !blobUrl) return;
    if (runtime.photoCache.has(key)) runtime.photoCache.delete(key);
    runtime.photoCache.set(key, {url: blobUrl, createdAt: Date.now()});
    while (runtime.photoCache.size > PHOTO_CACHE_LIMIT) {
      const oldestKey = runtime.photoCache.keys().next().value;
      const oldest = runtime.photoCache.get(oldestKey);
      runtime.photoCache.delete(oldestKey);
      try {
        if (oldest && oldest.url) URL.revokeObjectURL(oldest.url);
      } catch (_) {}
    }
  }

  function photoBlobUrl(photoId) {
    const key = String(photoId || '');
    const cached = runtime.photoCache.get(key);
    if (!cached) return '';
    runtime.photoCache.delete(key);
    runtime.photoCache.set(key, cached);
    return cached.url || '';
  }

  function clearPhotoCache() {
    for (const item of runtime.photoCache.values()) {
      try {
        if (item && item.url) URL.revokeObjectURL(item.url);
      } catch (_) {}
    }
    runtime.photoCache.clear();
  }

  function ensurePhotoKey(root) {
    if (!root || !root.isConnected) return '';
    let key = root.getAttribute('data-pal-photo-key') || '';
    if (!key) {
      key = `pal_photo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
      root.setAttribute('data-pal-photo-key', key);
    }
    return key;
  }

  function requestPhotoMetaCache(root, force = false) {
    const key = ensurePhotoKey(root);
    if (!key) return '';
    const now = Date.now();
    const last = Number(root.getAttribute('data-pal-photo-cache-at') || 0);
    if (!force && last && now - last < PHOTO_META_REFRESH_MS) return key;
    root.setAttribute('data-pal-photo-cache-at', String(now));
    window.postMessage({source: 'pal-content', channel: BRIDGE_CHANNEL, type: 'cache-photo-meta', photoKey: key}, '*');
    return key;
  }

  function fetchPhotoBlob(root) {
    return new Promise(resolve => {
      const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const photoKey = root && root.isConnected ? requestPhotoMetaCache(root, true) : '';
      const finish = value => {
        if (root && root.isConnected) root.removeAttribute('data-pal-photo-request');
        resolve(value);
      };
      runtime.pendingPhoto.set(requestId, finish);
      if (root && root.isConnected) root.setAttribute('data-pal-photo-request', requestId);
      window.postMessage({source: 'pal-content', channel: BRIDGE_CHANNEL, type: 'fetch-photo', requestId, photoKey}, '*');
      setTimeout(() => {
        if (runtime.pendingPhoto.has(requestId)) {
          runtime.pendingPhoto.delete(requestId);
          finish({ok: false, error: 'photo request timeout'});
        }
      }, 7000);
    });
  }

  async function openPhoto(root, btn, viewer) {
    if (!runtime.hasToken) {
      renderViewerMessage(viewer, 'Сессия Pure ещё не готова. Сделай любое действие в Pure и попробуй снова.');
      showToast('JWT ещё не пойман. Сделай любое действие в Pure и попробуй снова.');
      return;
    }
    try {
      btn.textContent = '...';
      btn.disabled = true;
      const response = await fetchPhotoBlob(root);
      if (!response || !response.ok || !response.blobUrl) throw new Error(response && response.error ? response.error : 'photo fetch failed');
      const blobUrl = response.blobUrl;
      rememberPhotoBlob(response.photoId, blobUrl);
      renderPhotoBlob(blobUrl, viewer);
      btn.textContent = 'открыто';
      setTimeout(() => {
        btn.textContent = 'Открыть';
        btn.disabled = false;
      }, 1200);
    } catch (error) {
      btn.textContent = 'Открыть';
      btn.disabled = false;
      renderViewerMessage(viewer, error.message || String(error));
      showToast(error.message || String(error));
    }
  }

  function findPhotoRoot(el) {
    let cur = el;
    for (let i = 0; i < 10 && cur && cur !== document.body; i += 1) {
      const rect = cur.getBoundingClientRect();
      if (rect.width >= 100 && rect.width <= 900 && rect.height >= 100 && rect.height <= 900) return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  function decoratePhotoPlaceholders() {
    if (!runtime.settings.photoOpener || !document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!/ТОЛЬКО В ПРИЛОЖЕНИИ/i.test(node.nodeValue || '')) continue;
      const root = findPhotoRoot(node.parentElement);
      if (!root) continue;
      if (root.hasAttribute('data-pal-photo-marked')) {
        requestPhotoMetaCache(root);
        continue;
      }
      root.setAttribute('data-pal-photo-marked', '1');
      requestPhotoMetaCache(root, true);
      if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
      const btn = document.createElement('button');
      btn.className = 'pal-open-photo';
      btn.textContent = 'Открыть';
      btn.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        const viewer = openViewerShell();
        openPhoto(root, btn, viewer);
      };
      root.appendChild(btn);
    }
  }

  function schedulePhotoDecoration() {
    if (runtime.photoDecorateTimer) return;
    runtime.photoDecorateTimer = window.setTimeout(() => {
      runtime.photoDecorateTimer = 0;
      decoratePhotoPlaceholders();
    }, 120);
  }

  async function loadSettings() {
    await loadCapabilities();
    await loadSessionStats();
    runtime.settings = normalizeSettings(await storageGet(DEFAULTS));
    if (runtime.settings.profileCaptureEnabled) await loadProfileCaptures();
    else await loadProfileCaptureSummary();
    if (runtime.settings.enabled) startLiker();
    else stopLiker();
    updateBadge();
  }

  if (globalThis.__PAL_TEST_HOOKS__ && globalThis.__PAL_TEST_HOOKS__.__enabled === true) {
    globalThis.__PAL_TEST_HOOKS__.engagement = {
      createEngagementDetector,
      parseIncomingMessage,
      parseOutgoingMessage
    };
    globalThis.__PAL_TEST_HOOKS__.profileCapture = {
      profileFieldsFromText,
      descriptionKeyForText,
      profileCandidateFromCard,
      isPositiveLikeLabel,
      isLikeButton,
      nextFrame
    };
    return;
  }

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== 'pal-page-bridge') return;
    if (data.channel !== BRIDGE_CHANNEL) return;
    if (data.type === 'token') {
      runtime.hasToken = !!data.hasToken || !!data.bearer || runtime.hasToken;
      runtime.myUserId = data.userId || (data.bearer ? decodeBearerUserId(data.bearer) : runtime.myUserId);
      if (runtime.engagementDetector && runtime.myUserId) {
        runtime.engagementDetector.setMyUserId(runtime.myUserId);
      }
      updateBadge();
    }
    if (data.type === 'photo-result' && runtime.pendingPhoto.has(data.requestId)) {
      const resolve = runtime.pendingPhoto.get(data.requestId);
      runtime.pendingPhoto.delete(data.requestId);
      resolve({
        ok: !!data.ok,
        photoId: data.photoId || '',
        blobUrl: data.blobUrl || '',
        error: data.error || ''
      });
    }
    if (data.type === 'net-event') {
      handleNetEvent(data.event);
    }
  });

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'pal-status') {
      sendResponse({
        running: runtime.running,
        likes: runtime.likes,
        failures: runtime.failures,
        lastError: runtime.lastError,
        hasToken: !!runtime.hasToken,
        runnerLock: runtime.runnerLock,
        runnerOwner: runtime.runnerOwner,
        sessionStats: runtime.sessionStats || defaultSessionStats(),
        timers: {
          autoStopMinutes: runtime.settings.autoStopMinutes,
          closeTabMinutes: runtime.settings.closeTabMinutes,
          autoStopAt: runtime.timerDeadlines.autoStopAt,
          closeTabAt: runtime.timerDeadlines.closeTabAt,
          mode: runtime.timerMode,
          now: new Date().toISOString()
        },
        diagnostics: runtime.diagnostics,
        telegramConfigured: runtime.telegramConfigured,
        telegramSent: runtime.telegramSent,
        telegramLastError: runtime.telegramLastError,
        telegramLastEvent: runtime.telegramLastEvent,
        profileCaptureEnabled: !!runtime.settings.profileCaptureEnabled,
        profileCaptureCount: runtime.profileCaptureLoaded ? runtime.profileCaptures.length : (runtime.profileCaptureStorage.count || 0),
        profileCaptureLastError: runtime.profileCaptureLastError,
        profileCaptureStorage: runtime.profileCaptureStorage
      });
      return false;
    }
    if (message && message.type === 'pal-profile-captures-flush') {
      flushProfileCaptures()
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ok: false, error: error.message || String(error)}));
      return true;
    }
    if (message && message.type === 'pal-profile-captures-clear') {
      clearProfileCaptures()
        .then(() => sendResponse({ok: true, count: 0}))
        .catch(error => sendResponse({ok: false, error: error.message || String(error)}));
      return true;
    }
    if (message && message.type === 'pal-timer-fired') {
      let action = Promise.resolve();
      if (message.action === 'auto-stop') {
        action = disableFromTimer('Таймер остановил автолайкер', {clearTimers: false, localOnly: true});
      } else if (message.action === 'close-tab') {
        action = disableFromTimer('Таймер закрывает вкладку Pure', {localOnly: true});
      }
      Promise.resolve(action)
        .then(() => sendResponse({ok: true}))
        .catch(error => sendResponse({ok: false, error: error.message || String(error)}));
      return true;
    }
    if (message && message.type === 'pal-settings-updated') {
      runtime.settings = normalizeSettings(message.settings || {});
      let action = Promise.resolve();
      if (!runtime.settings.enabled) action = stopLiker();
      else if (message.startRunner) action = startLiker({resetStats: !!message.resetStats});
      else if (runtime.running) action = scheduleRunTimers();
      if (runtime.settings.profileCaptureEnabled && !runtime.profileCaptureLoaded) {
        action = action.then(() => loadProfileCaptures());
      }
      Promise.resolve(action)
        .then(() => sendResponse({
          ok: true,
          running: runtime.running,
          runnerLock: runtime.runnerLock,
          runnerOwner: runtime.runnerOwner,
          lastError: runtime.lastError
        }))
        .catch(error => {
          runtime.lastError = error.message || String(error);
          sendResponse({ok: false, error: runtime.lastError});
        });
      return true;
    }
    return false;
  });

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let settingsChanged = false;
    let enabledChanged = false;
    let profileCaptureEnabledChanged = false;
    for (const [key, change] of Object.entries(changes)) {
      if (!(key in DEFAULTS)) continue;
      runtime.settings[key] = change.newValue;
      settingsChanged = true;
      if (key === 'enabled') enabledChanged = true;
      if (key === 'profileCaptureEnabled') profileCaptureEnabledChanged = true;
    }
    runtime.settings = normalizeSettings(runtime.settings);
    if (!settingsChanged) return;
    if (profileCaptureEnabledChanged && runtime.settings.profileCaptureEnabled && !runtime.profileCaptureLoaded) {
      void loadProfileCaptures();
    }
    if (!enabledChanged && runtime.running && runtime.settings.enabled) {
      void scheduleRunTimers();
      return;
    }
    if (!enabledChanged) return;
    if (runtime.settings.enabled) startLiker();
    else stopLiker({clearTimers: !runtime.timerStopInProgress && !runtime.timerDeadlines.closeTabAt});
  });

  window.addEventListener('pagehide', () => {
    if (runtime.runnerLock) {
      void releaseRunnerLock();
      void sendRuntime({type: 'pal-debugger-detach'});
    }
    clearLocalRunTimers();
    clearPhotoCache();
    void flushSessionStats();
    void flushProfileCaptures();
  });
  window.addEventListener('resize', refreshBadgePosition);

  runtime.engagementDetector = createEngagementDetector();
  injectPageBridge();
  window.postMessage({source: 'pal-content', channel: BRIDGE_CHANNEL, type: 'get-token'}, '*');
  loadSettings();
  updateBadge();
  decoratePhotoPlaceholders();
  const observer = new MutationObserver(schedulePhotoDecoration);
  if (document.documentElement) observer.observe(document.documentElement, {childList: true, subtree: true});
  setInterval(schedulePhotoDecoration, 1800);
  setInterval(refreshBadgePosition, 2500);
})();
