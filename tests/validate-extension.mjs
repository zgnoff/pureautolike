import {access, readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFile(resolve(root, path), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseScript(source, label) {
  new vm.Script(source, {filename: label});
}

function hasHost(manifest, host) {
  return (manifest.host_permissions || []).includes(host);
}

function validateCommonManifest(manifest, label) {
  assert(manifest.manifest_version === 3, `${label}: manifest must be MV3`);
  assert(manifest.action?.default_popup === 'popup.html', `${label}: popup missing`);
  assert(manifest.permissions.includes('storage'), `${label}: missing storage permission`);
  assert(manifest.permissions.includes('tabs'), `${label}: missing tabs permission`);
  assert(manifest.permissions.includes('alarms'), `${label}: missing alarms permission`);
  for (const host of ['https://pure.app/*', 'https://api.telegram.org/*']) {
    assert(hasHost(manifest, host), `${label}: missing host permission ${host}`);
  }
  for (const host of ['https://api.thepure.app/*', 'https://cdn.thepure.app/*']) {
    assert(!hasHost(manifest, host), `${label}: unnecessary host permission ${host}`);
  }
  const content = manifest.content_scripts.find(item => item.js?.includes('src/content.js'));
  assert(content?.css?.includes('src/content.css'), `${label}: content script css missing`);
  assert(content?.run_at === 'document_start', `${label}: content script must run before Pure opens WebSocket`);
  const war = manifest.web_accessible_resources || [];
  assert(
    JSON.stringify(war).includes('src/page-bridge.js'),
    `${label}: page bridge must be web-accessible`
  );
}

const rootManifest = JSON.parse(await read('manifest.json'));
const pkg = JSON.parse(await read('package.json'));
validateCommonManifest(rootManifest, 'root');
assert(rootManifest.permissions.includes('debugger'), 'root: Chromium dev manifest must include debugger');
assert(rootManifest.background?.service_worker === 'src/background.js', 'root: service worker missing');
assert(pkg.version === rootManifest.version, 'package and root manifest versions must match');
assert(pkg.scripts?.package?.includes('tools/package.mjs'), 'package script must build release ZIPs');

const targets = {
  chromium: JSON.parse(await read('manifests/chromium.json')),
  firefox: JSON.parse(await read('manifests/firefox.json')),
  safari: JSON.parse(await read('manifests/safari.json'))
};

for (const [target, manifest] of Object.entries(targets)) {
  validateCommonManifest(manifest, target);
}
assert(targets.chromium.permissions.includes('debugger'), 'chromium: debugger permission missing');
assert(rootManifest.permissions.includes('unlimitedStorage'), 'root: Chromium dev manifest should allow larger local profile exports');
assert(targets.chromium.permissions.includes('unlimitedStorage'), 'chromium: should allow larger local profile exports');
assert(targets.firefox.permissions.includes('unlimitedStorage'), 'firefox: should allow larger local profile exports');
assert(targets.chromium.background?.service_worker === 'src/background.js', 'chromium: service worker missing');
assert(!targets.firefox.permissions.includes('debugger'), 'firefox: must not request debugger');
assert(targets.firefox.background?.scripts?.includes('src/background.js'), 'firefox: background scripts missing');
assert(targets.firefox.browser_specific_settings?.gecko?.id, 'firefox: gecko id missing');
assert(!targets.safari.permissions.includes('debugger'), 'safari: must not request debugger');
assert(targets.safari.background?.scripts?.includes('src/background.js'), 'safari: background scripts missing');

const files = [
  'src/background.js',
  'src/page-bridge.js',
  'src/content.js',
  'src/popup.js'
];
for (const file of files) {
  const source = await read(file);
  parseScript(source, file);
}

for (const file of ['tools/build.mjs', 'tools/package.mjs']) {
  const check = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8'
  });
  assert(check.status === 0, `${file} syntax check failed: ${check.stderr || check.stdout}`);
}

const background = await read('src/background.js');
assert(background.includes('Input.dispatchMouseEvent'), 'background must use CDP mouse events when available');
assert(background.includes('debugger API is unavailable'), 'background must degrade when debugger is missing');
assert(background.includes('pal-telegram-send'), 'background must handle Telegram sends');
assert(background.includes('pal-telegram-event'), 'background must own Telegram event sends');
assert(background.includes('TELEGRAM_STATE_KEY'), 'background must persist Telegram notification runtime state');
assert(background.includes('TELEGRAM_CONFIG_BACKUP_KEY'), 'background must preserve Telegram config across extension updates');
assert(background.includes('telegramSettings()'), 'background must read Telegram secrets through the restore layer');
assert(background.includes('api.telegram.org'), 'background must send Telegram notifications through Bot API');
assert(background.includes('pal-runner-claim'), 'background must provide a single-runner claim lock');
assert(background.includes('palRunnerLock'), 'background must persist the runner lock');
assert(background.includes('tabs.onRemoved'), 'background must clear runner lock when the owner tab closes');
assert(background.includes('pal-capabilities'), 'background must report browser capabilities');
assert(background.includes('currentRunnerLock'), 'background must clear stale runner locks in status checks');
assert(background.includes('5 * 60 * 1000'), 'background must not release hidden-tab runner locks too aggressively');
assert(background.includes('autoDiscardable'), 'background must prevent the active runner tab from being browser-discarded when possible');
assert(background.includes('pal-close-tab'), 'background must close the owner Pure tab on timer request');
assert(background.includes('tabsRemove'), 'background must wrap browser tab closing safely');
assert(background.includes('palRunnerTimers'), 'background must persist timer state for hidden-tab continuity');
assert(background.includes('ext.alarms.onAlarm'), 'background must listen for browser alarms');
assert(background.includes('pal-runner-timers-set'), 'background must schedule runner timers through alarms');
assert(background.includes('pal-timer-fired'), 'background must notify content when a timer fires');
assert(background.includes('LICENSE_STATE_KEY'), 'background must persist license status');
assert(background.includes('INSTALLATION_ID_KEY'), 'background must persist anonymous installation id');
assert(background.includes('LICENSE_CHANNEL'), 'background must send a release channel to the license backend');
assert(background.includes('LICENSE_BETA_FALLBACK = false'), 'background must not allow a local beta fallback when the license backend fails');
assert(background.includes('license_endpoint_missing'), 'background must lock access if the license endpoint is missing');
assert(background.includes('pal-license-check'), 'background must expose license checks to the popup');
assert(background.includes('pal-license-status'), 'background must expose cached license status');
assert(background.includes('checkLicense()'), 'background must verify license before runner claim');

const content = await read('src/content.js');
const contentCss = await read('src/content.css');
assert(content.includes('injectPageBridge'), 'content must inject the page bridge');
assert(content.includes('BRIDGE_CHANNEL'), 'content must isolate page bridge messages with a channel');
assert(content.includes('HEART_PATH_PREFIX'), 'content must keep heart-path detection');
assert(content.includes('pal-debugger-click'), 'content must request debugger click');
assert(content.includes('candidate.el.click()'), 'content must fall back to DOM click');
assert(content.includes('loadCapabilities'), 'content must normalize settings by browser capabilities');
assert(content.includes('feedScroller'), 'content must detect the Pure feed scroll container');
assert(content.includes('scrollFeed'), 'content must scroll the feed container when no like is visible');
assert(content.includes('#recommendations-list'), 'content must prefer Pure recommendation list scroll context');
assert(content.includes('ТОЛЬКО В ПРИЛОЖЕНИИ'), 'content must decorate hidden photo placeholders');
assert(!content.includes('resolve-photo-meta'), 'content must not request raw photo metadata from the page bridge');
assert(content.includes('renderViewerMessage'), 'content must replace the photo loading tab with an error message when opening fails');
assert(content.includes('MutationObserver(check)'), 'content must confirm clicks from DOM mutations');
assert(content.includes('SEEN_SIGNATURE_LIMIT'), 'content must bound session duplicate memory');
assert(content.includes('CLICK_RETRY_CONFIRM_MS'), 'content must retry unconfirmed clicks without slowing the normal path');
assert(content.includes('EMPTY_RENDER_GRACE_MS'), 'content must wait briefly before scrolling past late-rendered buttons');
assert(content.includes('FRAME_FALLBACK_MS'), 'content must not hang on paused requestAnimationFrame in hidden tabs');
assert(content.includes('document.hidden'), 'content must use a timer fallback while the Pure tab is hidden');
assert(content.includes('pointTargetsButton'), 'content must avoid clicking through blocking overlays');
assert(content.includes('retryClickLike'), 'content must retry a missed visible like before scrolling');
assert(content.includes('findBadgeAnchorRect'), 'content must anchor runtime badge near Pure UI');
assert(content.includes('findLogoBadgeAnchorRect'), 'content must prefer the Pure logo as the runtime badge anchor');
assert(content.includes("kind: 'logo'"), 'content must mark logo badge anchors distinctly');
assert(content.includes('pal-badge-count'), 'content must render a structured Pure-branded badge');
assert(contentCss.includes('.pal-badge::before'), 'content badge must include a Pure pink edge');
assert(contentCss.includes('#161416'), 'content badge must use the Pure dark header color');
assert(contentCss.includes('#f20557'), 'content badge must use the Pure pink accent');
assert(content.includes('refreshBadgePosition'), 'content must re-anchor badge after Pure UI renders or resizes');
assert(!content.includes('jwt:'), 'content badge must not expose debug jwt text');
assert(content.includes('schedulePhotoDecoration'), 'content must debounce photo placeholder scans');
assert(content.includes('createEngagementDetector'), 'content must classify Pure engagement events');
assert(content.includes('historyBaselinedThreads'), 'content must baseline chat history per thread before Telegram notifications');
assert(content.includes('telegramEnabled'), 'content must support Telegram settings');
assert(content.includes('pal-telegram-event'), 'content must route sanitized event notifications to background');
assert(!content.includes('telegramBotToken'), 'content must not receive Telegram bot tokens');
assert(!content.includes('telegramChatId'), 'content must not receive Telegram chat ids');
assert(content.includes('pal-runner-claim'), 'content must claim the single-runner lock before starting');
assert(content.includes('pal-runner-heartbeat'), 'content must keep the runner lock alive');
assert(content.includes('pal-runner-release'), 'content must release the runner lock on stop');
assert(content.includes('key in DEFAULTS'), 'content must ignore non-settings storage keys');
assert(content.includes('message.startRunner'), 'content must only start from explicit runner intent');
assert(content.includes('PROFILE_CAPTURE_KEY'), 'content must define local profile capture storage');
assert(content.includes('profileCaptureEnabled'), 'content must support profile capture setting');
assert(content.includes('profileDescriptionFromCard'), 'content must extract profile text from cards');
assert(content.includes('profileFieldsFromText'), 'content must extract structured profile fields');
assert(content.includes('descriptionKeyForText'), 'content must dedupe repeated profile descriptions');
assert(!content.includes('PROFILE_CAPTURE_LIMIT'), 'content must not impose an app-side profile capture count limit');
assert(content.includes('PROFILE_CAPTURE_INDEX_KEY'), 'content must store profile captures through a chunk index');
assert(content.includes('PROFILE_CAPTURE_CHUNK_PREFIX'), 'content must split large profile exports into storage chunks');
assert(content.includes('PROFILE_CAPTURE_CHUNK_SIZE'), 'content must have deterministic profile storage chunking');
assert(content.includes('SESSION_STATS_KEY'), 'content must persist session stats for popup reopen/hidden-tab continuity');
assert(content.includes('autoStopMinutes'), 'content must support the autoliker stop timer setting');
assert(content.includes('closeTabMinutes'), 'content must support the Pure tab close timer setting');
assert(content.includes('scheduleRunTimers'), 'content must schedule runtime stop/close timers');
assert(content.includes('timerStopInProgress'), 'content must keep stop and close timers independent');
assert(content.includes('pal-close-tab'), 'content must ask background to close the Pure tab');
assert(content.includes('pal-runner-timers-set'), 'content must prefer background alarms for runner timers');
assert(content.includes('pal-timer-fired'), 'content must handle background timer callbacks');
assert(content.includes('profileCaptureStorage'), 'content must report profile capture storage diagnostics');
assert(content.includes('diagnostics'), 'content must report autoliker diagnostics to the popup');
assert(content.includes('PHOTO_CACHE_LIMIT'), 'content must bound opened-photo blob cache size');
assert(content.includes('isLikeButton'), 'content must keep a resilient like button detector');
assert(content.includes('captureProfile'), 'content must capture visible profile descriptions');
assert(content.includes('captureVisibleProfiles'), 'content must capture visible profile cards independently of like buttons');
assert(content.includes('profileCandidateFromCard'), 'content must build capture candidates from cards without click controls');
assert(content.includes('NOTIFICATION_MEMORY_LIMIT'), 'content must bound notification dedupe memory');
assert(!content.includes('TELEGRAM_SENT_MEMORY_LIMIT'), 'content must not own Telegram send dedupe memory');
assert(content.includes("type: 'fetch-photo'"), 'content must request photo blobs through the page bridge');
assert(content.includes("'photo-result'"), 'content must receive photo blobs from the page bridge');
assert(content.includes('data-pal-photo-key'), 'content must assign stable keys to decorated photo placeholders');
assert(content.includes("type: 'cache-photo-meta'"), 'content must warm page-side photo metadata cache before stale clicks');
assert(content.includes('runtime.hasToken'), 'content must track token readiness without storing Pure bearer');
assert(!content.includes('runtime.bearer'), 'content must not store the Pure bearer token');
assert(!content.includes("'Authorization': runtime"), 'content must not issue bearer-authenticated Pure API requests');
assert(content.includes('bytes,'), 'content must persist profile capture byte counts in the index');
assert(content.includes('appendStoredProfiles'), 'content must append new profile captures without rewriting every chunk');
assert(content.includes('rewriteStoredProfiles'), 'content must retain a full rewrite fallback for legacy storage');
const processVisibleSlice = content.slice(content.indexOf('async function processVisible()'), content.indexOf('async function likerLoop()'));
assert(processVisibleSlice.includes('captureVisibleProfiles()'), 'processVisible must collect visible profile cards before liking');
assert(
  processVisibleSlice.indexOf('captureVisibleProfiles()') < processVisibleSlice.indexOf('detectLikeButtons()'),
  'visible profile capture must run before like-button detection so already-liked cards are included'
);
assert(content.includes('pal-profile-captures-flush'), 'content must flush profile captures for export');
assert(content.includes('pal-profile-captures-clear'), 'content must clear profile captures from popup');
assert(content.includes('__PAL_TEST_HOOKS__'), 'content must expose parser hooks for fixture tests only');
const loadSettingsSlice = content.slice(content.indexOf('async function loadSettings()'), content.indexOf('if (globalThis.__PAL_TEST_HOOKS__'));
assert(
  loadSettingsSlice.indexOf('runtime.settings = normalizeSettings') < loadSettingsSlice.indexOf('loadProfileCaptures()'),
  'loadSettings must read settings before loading profile captures'
);
assert(loadSettingsSlice.includes('loadProfileCaptureSummary()'), 'loadSettings must use a summary when profile capture is disabled');

const bridge = await read('src/page-bridge.js');
assert(bridge.includes('CHANNEL'), 'bridge must use a scoped message channel');
assert(bridge.includes('window.fetch = function'), 'bridge must hook fetch');
assert(bridge.includes('XMLHttpRequest.prototype.setRequestHeader'), 'bridge must hook XHR headers');
assert(bridge.includes('/chats-service/') && bridge.includes('/ws/'), 'bridge must hook Pure chat-service websocket');
assert(bridge.includes('extractPhotoMeta'), 'bridge must expose photo metadata extraction');
assert(bridge.includes('net-event'), 'bridge must publish network events');
assert(bridge.includes('WebSocket'), 'bridge must hook Pure WebSocket frames');
assert(bridge.includes('hasToken: !!state.bearer'), 'bridge must publish token readiness without exposing bearer');
assert(!bridge.includes('bearer: state.bearer'), 'bridge must not post the Pure bearer token to content');
assert(bridge.includes('fetchPhotoBlob'), 'bridge must fetch protected Pure photos inside page context');
assert(bridge.includes("type: 'photo-result'"), 'bridge must return photo fetch results over the scoped channel');
assert(bridge.includes('PHOTO_META_CACHE_LIMIT'), 'bridge must keep a bounded photo metadata cache');
assert(bridge.includes('resolvePhotoMetaForRoot'), 'bridge must fall back to cached photo metadata for stale roots');
assert(bridge.includes("data.type === 'cache-photo-meta'"), 'bridge must accept page-side photo metadata cache warmup');
const fetchPhotoHandler = bridge.slice(bridge.indexOf("if (data.type === 'fetch-photo')"), bridge.indexOf('});', bridge.indexOf("if (data.type === 'fetch-photo')")));
assert(fetchPhotoHandler.includes('resolvePhotoMetaForRoot(root'), 'bridge fetch-photo handler must derive or restore metadata from the marked DOM root');
assert(!fetchPhotoHandler.includes('data.meta'), 'bridge fetch-photo handler must not trust metadata supplied by content');

const popup = await read('popup.html');
for (const id of ['licenseBadge', 'languageToggle', 'feedbackLink', 'likes', 'telegramEnabled', 'telegramBotToken', 'telegramChatId', 'telegramMatches', 'telegramMessages', 'telegramLikes', 'telegramTest', 'profileCaptureEnabled', 'profileCaptureExport', 'profileCaptureClear', 'profileCaptureCount', 'autoStopMinutes', 'closeTabMinutes', 'timerStatus', 'clickJitter']) {
  assert(popup.includes(`id="${id}"`), `popup must expose ${id}`);
}
assert(popup.includes('https://github.com/zgnme/pureautolike/issues/new/choose'), 'popup must link feedback to GitHub issue forms');
assert(popup.includes('BETA'), 'popup must show a beta badge while access is free');
assert(popup.includes('id="telegramPanel"'), 'popup must expose Telegram panel state');
for (const removedMetric of ['id="failures"', 'id="tokenState"', 'Ошибки', 'Сессия', 'diagnosticsText', 'diagnostic-panel']) {
  assert(!popup.includes(removedMetric), `popup must not expose removed metric/diagnostic UI ${removedMetric}`);
}
assert(!popup.includes('JWT'), 'popup must not expose JWT jargon');
assert(popup.includes('type="hidden" id="clickJitter"'), 'popup must keep click jitter as an internal hidden setting');
assert(!popup.includes('Смещение точки клика'), 'popup must not expose click jitter as a visible user control');
assert(!popup.includes('Разброс клика'), 'popup must not use unclear click jitter wording');
for (const removedVisual of ['Speed', 'Daily limit', 'Скорость', 'Дневной лимит']) {
  assert(!popup.includes(removedVisual), `popup must not expose fake visual control ${removedVisual}`);
}
const popupIconAssets = [
  'pure-eye.png',
  'like-heart.png',
  'timer-alarm.png',
  'profile-capture.png',
  'export-markdown.png',
  'telegram-plane.png'
];
for (const icon of popupIconAssets) {
  assert(popup.includes(`src/icons/${icon}`), `popup must render generated Pure-style icon ${icon}`);
}
for (const removed of ['id="useDebugger"', 'id="humanizeMouse"', 'id="photoOpener"', 'id="sessionLimit"', 'Системный клик', 'Плавная мышь', 'Лимит лайков']) {
  assert(!popup.includes(removed), `popup must not expose technical control ${removed}`);
}
const popupScript = await read('src/popup.js');
assert(popupScript.includes('startRunner: true'), 'popup start button must give the active tab first runner claim');
assert(popupScript.includes('NATIVE_SETTINGS'), 'popup must keep native settings enforced');
assert(popupScript.includes('loadCapabilities'), 'popup must normalize native settings by browser capabilities');
assert(popupScript.includes('PROFILE_CAPTURE_KEY'), 'popup must read local profile captures');
assert(popupScript.includes('PROFILE_CAPTURE_INDEX_KEY'), 'popup must read chunked local profile captures');
assert(popupScript.includes('timerPatchFromControls'), 'popup must save timer settings');
assert(popupScript.includes('renderTimerRuntime'), 'popup must render active timer countdowns');
assert(popupScript.includes('uiLanguage'), 'popup must persist RU/EN language preference');
assert(popupScript.includes('applyLanguage'), 'popup must switch visible labels between RU and EN');
assert(popupScript.includes('refreshLicense'), 'popup must render license status');
assert(popupScript.includes('pal-license-check'), 'popup must ask background for license access before start');
assert(!popupScript.includes('diagnosticsText'), 'popup must not render visible autoliker diagnostics');
assert(!popupScript.includes('profileCaptureStorage'), 'popup must not render visible profile storage diagnostics');
assert(popupScript.includes('markdownForProfiles'), 'popup must export profile captures as Markdown');
assert(popupScript.includes('downloadMarkdown'), 'popup must download profile capture Markdown');
assert(popupScript.includes('Статус/интент'), 'popup Markdown export must include profile status');
assert(popupScript.includes('Возраст'), 'popup Markdown export must include profile age');
assert(popupScript.includes('contentSettings'), 'popup must sanitize settings before sending them to content');
assert(popupScript.includes('CONTENT_SECRET_KEYS'), 'popup must keep Telegram secrets out of content messages');
assert(popupScript.includes('TELEGRAM_CONFIG_BACKUP_KEY'), 'popup must backup Telegram token/chat id for extension updates');
assert(popupScript.includes('pal-telegram-status'), 'popup must read Telegram notification runtime state from background');
assert(!popupScript.includes('setInterval(refreshStats'), 'popup must not poll with overlapping setInterval calls');
assert(popupScript.includes('refreshInFlight'), 'popup must prevent overlapping refresh calls');
const refreshStatsSlice = popupScript.slice(popupScript.indexOf('async function refreshStats()'), popupScript.indexOf('function scheduleRefresh'));
assert(!refreshStatsSlice.includes('storedProfiles('), 'popup refreshStats must not load all profile captures every second');
assert(refreshStatsSlice.includes('profileStorageSummary()'), 'popup refreshStats must read the lightweight profile index');

await import('./cloud-gateway-docs.mjs');
const worker = await read('backend/license-worker/src/worker.js');
const workerCheck = spawnSync(process.execPath, ['--check', 'backend/license-worker/src/worker.js'], {
  cwd: root,
  encoding: 'utf8'
});
assert(workerCheck.status === 0, `license worker syntax check failed: ${workerCheck.stderr || workerCheck.stdout}`);
assert(worker.includes('/v1/license/check'), 'license worker must expose license check endpoint');
assert(worker.includes('BETA_ENABLED'), 'license worker must support free beta mode');
assert(worker.includes('ALLOWED_EXTENSION_IDS'), 'license worker must restrict future production extension ids');
assert(worker.includes('CHECKOUT_URL'), 'license worker must expose future checkout handoff');
assert(worker.includes('/v1/billing/webhook'), 'license worker must reserve billing webhook endpoint');
const backendSchema = await read('backend/license-worker/schema.sql');
for (const table of ['installations', 'users', 'entitlements', 'license_checks']) {
  assert(backendSchema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `license backend schema must define ${table}`);
}
const buildTool = await read('tools/build.mjs');
assert(!buildTool.includes('backend/license-worker'), 'backend scaffold must not be packaged into extension builds');

const build = spawnSync(process.execPath, ['tools/build.mjs', 'all'], {
  cwd: root,
  encoding: 'utf8'
});
assert(build.status === 0, `build failed: ${build.stderr || build.stdout}`);
for (const target of Object.keys(targets)) {
  const builtManifest = JSON.parse(await read(`dist/${target}/manifest.json`));
  validateCommonManifest(builtManifest, `dist/${target}`);
  const builtBackground = await read(`dist/${target}/src/background.js`);
  const expectedChannel = {
    chromium: 'chrome-web-store',
    firefox: 'firefox-amo',
    safari: 'safari-app-store'
  }[target];
  assert(builtBackground.includes(`const LICENSE_CHANNEL = '${expectedChannel}';`), `${target}: license channel must match release target`);
  for (const icon of popupIconAssets) {
    await access(resolve(root, `dist/${target}/src/icons/${icon}`));
  }
}

console.log('extension validation passed');
