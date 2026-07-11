#!/usr/bin/env node
import {mkdir, writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {relative, resolve, join} from 'node:path';
import {buildSafeProtocolFixture} from './pure-protocol-sanitize.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const DEFAULT_DURATION_MS = 90_000;
const BODY_TEXT_LIMIT = 192 * 1024;
const MAX_EVENTS_IN_MEMORY = 4000;
const ANALYSIS_ROOT = resolve('analysis');

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const requestedOutDir = resolve(String(args.out || 'analysis/pure-api-listener'));
assertAnalysisOutput(requestedOutDir);

const config = {
  host: String(args.host || DEFAULT_HOST),
  port: Number(args.port || DEFAULT_PORT),
  target: String(args.target || 'pure.app'),
  outDir: requestedOutDir,
  durationMs: Number(args.duration ?? DEFAULT_DURATION_MS),
  reload: Boolean(args.reload),
  includeResponseBodies: args.bodies !== false,
  includeGeoValues: args.geo !== false
};

const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const files = {
  events: join(config.outDir, `events-${runId}.ndjson`),
  summary: join(config.outDir, `summary-${runId}.json`),
  report: join(config.outDir, `report-${runId}.md`),
  fixture: join(config.outDir, `fixture-${runId}.json`)
};
const fileLabels = Object.fromEntries(
  Object.entries(files).map(([key, value]) => [key, relative(process.cwd(), value)])
);

const state = {
  startedAt: new Date(),
  target: null,
  requests: new Map(),
  websockets: new Map(),
  events: [],
  counters: {
    http: 0,
    websocket: 0,
    resourceSnapshot: 0,
    skippedBodies: 0,
    failedBodies: 0
  }
};

await mkdir(config.outDir, {recursive: true});
const out = createWriteStream(files.events, {flags: 'w'});

let cdp;
let stopping = false;
let outputClosed = false;
let stopTimer = null;
let keepAliveTimer = null;
let resolveStopped;
const stopped = new Promise(resolveDone => {
  resolveStopped = resolveDone;
});

try {
  const targets = await fetchJson(`http://${config.host}:${config.port}/json/list`);
  const target = chooseTarget(targets, config.target);
  if (!target) {
    const available = targets.map(item => `${item.type || 'unknown'} | ${item.title || ''} | ${item.url || ''}`).join('\n');
    throw new Error(`No matching Pure tab found on ${config.host}:${config.port}.\nAvailable targets:\n${available || '(none)'}`);
  }

  state.target = {
    id: target.id,
    title: target.title || '',
    url: target.url || ''
  };

  cdp = await connectCdp(target.webSocketDebuggerUrl);
  cdp.onEvent = handleCdpEvent;
  await cdp.send('Network.enable', {
    maxTotalBufferSize: 100_000_000,
    maxResourceBufferSize: 25_000_000
  });
  await cdp.send('Network.setCacheDisabled', {cacheDisabled: true}).catch(() => {});
  await cdp.send('Runtime.enable').catch(() => {});

  console.log(`listening: ${state.target.title || 'Pure tab'} | ${state.target.url}`);
  console.log(`output: ${files.events}`);
  console.log(`duration: ${config.durationMs > 0 ? `${Math.round(config.durationMs / 1000)}s` : 'until Ctrl-C'}`);

  if (config.reload) {
    await cdp.send('Page.enable').catch(() => {});
    await cdp.send('Page.reload', {ignoreCache: true}).catch(error => {
      console.warn(`reload skipped: ${error.message}`);
    });
  }

  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  if (config.durationMs > 0) {
    stopTimer = setTimeout(() => stop('duration'), config.durationMs);
  }
  keepAliveTimer = setInterval(() => {}, 1000);
  await stopped;
} catch (error) {
  await closeOutput();
  console.error(error.message || error);
  process.exitCode = 1;
}

async function stop(reason) {
  if (stopping) return;
  stopping = true;
  if (stopTimer) clearTimeout(stopTimer);
  try {
    try {
      if (cdp) {
        await withTimeout(captureResourceSnapshot(cdp), 3000, 'resource snapshot timeout')
          .catch(() => withTimeout(captureFreshResourceSnapshots(), 7000, 'fresh resource snapshot timeout'));
      }
    } catch (error) {
      writeEvent({
        kind: 'listener_error',
        ts: new Date().toISOString(),
        error: `resource snapshot failed: ${error.message || error}`
      });
    }
    const summary = buildSummary(reason);
    await writeFile(files.summary, `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(files.report, renderReport(summary));
    const fixture = buildSafeProtocolFixture(state.events);
    await writeFile(files.fixture, `${JSON.stringify(fixture)}\n`);
    console.log(`summary: ${files.summary}`);
    console.log(`report: ${files.report}`);
    console.log(`fixture: ${files.fixture}`);
  } catch (error) {
    console.error(`listener shutdown failed: ${error.message || error}`);
    process.exitCode = 1;
  } finally {
    try {
      if (cdp) cdp.close();
    } catch (_) {}
    await closeOutput().catch(error => {
      console.error(`listener output close failed: ${error.message || error}`);
      process.exitCode = 1;
    });
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (resolveStopped) resolveStopped();
  }
}

async function closeOutput() {
  if (outputClosed) return;
  outputClosed = true;
  await new Promise(resolveDone => out.end(resolveDone));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseArgs(raw) {
  const parsed = {};
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--reload') {
      parsed.reload = true;
      continue;
    }
    if (arg === '--no-bodies') {
      parsed.bodies = false;
      continue;
    }
    if (arg === '--no-geo-values') {
      parsed.geo = false;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = raw[i + 1];
    if (!value || value.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = value;
    i += 1;
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node tools/pure-api-listener.mjs --port 54502 --target pure.app --duration 120000 --reload

Options:
  --host <host>          CDP host, default 127.0.0.1
  --port <port>          CDP port, default 9222
  --target <text>        Pick a page target whose URL/title contains text, default pure.app
  --duration <ms>        Capture time in milliseconds. Use 0 for Ctrl-C mode
  --out <dir>            Raw output directory under gitignored analysis/
  --reload               Reload the selected Pure tab after attaching
  --no-bodies            Do not request response bodies from CDP
  --no-geo-values        Keep geo field names only, without coarse values
`);
}

function assertAnalysisOutput(outDir) {
  const pathFromAnalysis = relative(ANALYSIS_ROOT, outDir);
  if (pathFromAnalysis === '..' || pathFromAnalysis.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || resolve(outDir) === ANALYSIS_ROOT) {
    throw new Error('Raw listener output must be a subdirectory of analysis/');
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function chooseTarget(targets, needle) {
  return chooseTargets(targets, needle)[0] || null;
}

function chooseTargets(targets, needle) {
  const normalized = String(needle || '').toLowerCase();
  const pages = targets.filter(item => item.type === 'page' && item.webSocketDebuggerUrl);
  const matched = pages.filter(item => `${item.url || ''} ${item.title || ''}`.toLowerCase().includes(normalized));
  if (matched.length) return matched;
  return pages.filter(item => isPureUrl(item.url || ''));
}

function connectCdp(wsUrl) {
  return new Promise((resolveConnection, rejectConnection) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const connection = {
      send(method, params = {}) {
        const id = nextId;
        nextId += 1;
        ws.send(JSON.stringify({id, method, params}));
        return new Promise((resolveCall, rejectCall) => {
          pending.set(id, {resolve: resolveCall, reject: rejectCall, method});
        });
      },
      close() {
        ws.close();
      },
      onEvent: null
    };

    ws.addEventListener('message', event => {
      let message;
      try {
        message = JSON.parse(String(event.data || '{}'));
      } catch (_) {
        return;
      }
      if (message.id && pending.has(message.id)) {
        const item = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          item.reject(new Error(`${item.method}: ${message.error.message || JSON.stringify(message.error)}`));
        } else {
          item.resolve(message.result || {});
        }
        return;
      }
      if (message.method && connection.onEvent) connection.onEvent(message.method, message.params || {});
    });

    ws.addEventListener('error', error => rejectConnection(error), {once: true});

    ws.addEventListener('open', () => resolveConnection(connection), {once: true});
  });
}

async function handleCdpEvent(method, params) {
  try {
    if (method === 'Network.requestWillBeSent') {
      onRequest(params);
      return;
    }
    if (method === 'Network.responseReceived') {
      onResponse(params);
      return;
    }
    if (method === 'Network.loadingFinished') {
      await onFinished(params);
      return;
    }
    if (method === 'Network.loadingFailed') {
      onFailed(params);
      return;
    }
    if (method === 'Network.webSocketCreated') {
      onWebSocketCreated(params);
      return;
    }
    if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
      onWebSocketFrame(method, params);
    }
  } catch (error) {
    writeEvent({
      kind: 'listener_error',
      ts: new Date().toISOString(),
      error: String(error.message || error)
    });
  }
}

function onRequest(params) {
  const request = params.request || {};
  if (!isPureUrl(request.url || '')) return;
  const url = sanitizeUrl(request.url);
  const item = {
    requestId: params.requestId,
    method: String(request.method || 'GET').toUpperCase(),
    url,
    requestHeaderNames: Object.keys(request.headers || {}).sort(),
    requestPayload: summarizePayloadText(request.postData || ''),
    startedAt: new Date().toISOString()
  };
  state.requests.set(params.requestId, item);
}

function onResponse(params) {
  const response = params.response || {};
  if (!isPureUrl(response.url || '')) return;
  const previous = state.requests.get(params.requestId) || {};
  state.requests.set(params.requestId, {
    ...previous,
    requestId: params.requestId,
    method: previous.method || 'GET',
    url: previous.url || sanitizeUrl(response.url),
    status: response.status || 0,
    mimeType: response.mimeType || '',
    resourceType: params.type || '',
    remoteIPAddress: response.remoteIPAddress || '',
    responseHeaderNames: Object.keys(response.headers || {}).sort(),
    responseHeaders: summarizeHeaders(response.headers || {})
  });
}

async function onFinished(params) {
  const item = state.requests.get(params.requestId);
  if (!item || !item.url) return;
  let parsedBody = null;
  let bodySummary = null;
  let signals = null;
  const contentType = `${item.mimeType || ''} ${item.responseHeaders?.contentType || ''}`.toLowerCase();
  const mayHaveTextBody = /json|text|javascript|graphql|plain|html/.test(contentType);

  if (config.includeResponseBodies && mayHaveTextBody) {
    try {
      const body = await cdp.send('Network.getResponseBody', {requestId: params.requestId});
      const bodyText = body.base64Encoded ? '' : boundedText(body.body || '');
      if (bodyText) {
        parsedBody = parsePayload(bodyText);
        bodySummary = summarizeValue(parsedBody, {includeGeoValues: config.includeGeoValues});
        signals = extractSignals(parsedBody, item.url.path, config);
      }
    } catch (_) {
      state.counters.failedBodies += 1;
    }
  } else {
    state.counters.skippedBodies += 1;
  }

  writeEvent({
    kind: 'http',
    ts: new Date().toISOString(),
    method: item.method,
    host: item.url.host,
    path: item.url.path,
    queryKeys: item.url.queryKeys,
    queryValues: item.url.queryValues,
    status: item.status || 0,
    resourceType: item.resourceType || '',
    contentType: item.mimeType || item.responseHeaders?.contentType || '',
    requestHeaderNames: item.requestHeaderNames,
    responseHeaderNames: item.responseHeaderNames,
    requestPayload: item.requestPayload,
    responseSummary: bodySummary,
    signals: mergeSignals(signals, signalsForUrl(item.url, item.status || 0))
  });
  state.requests.delete(params.requestId);
}

function onFailed(params) {
  const item = state.requests.get(params.requestId);
  if (!item || !item.url) return;
  writeEvent({
    kind: 'http_failed',
    ts: new Date().toISOString(),
    method: item.method,
    host: item.url.host,
    path: item.url.path,
    queryKeys: item.url.queryKeys,
    queryValues: item.url.queryValues,
    errorText: params.errorText || '',
    canceled: Boolean(params.canceled),
    signals: signalsForUrl(item.url, 0)
  });
  state.requests.delete(params.requestId);
}

function onWebSocketCreated(params) {
  if (!isPureUrl(params.url || '')) return;
  const url = sanitizeUrl(params.url);
  state.websockets.set(params.requestId, url);
  writeEvent({
    kind: 'ws_created',
    ts: new Date().toISOString(),
    host: url.host,
    path: url.path,
    queryKeys: url.queryKeys,
    queryValues: url.queryValues,
    signals: signalsForUrl(url, 0)
  });
}

function onWebSocketFrame(method, params) {
  const url = state.websockets.get(params.requestId);
  if (!url) return;
  const payload = params.response?.payloadData || '';
  const parsed = parsePayload(payload);
  const signals = extractSignals(parsed, url.path, config);
  writeEvent({
    kind: method === 'Network.webSocketFrameSent' ? 'ws_sent' : 'ws_received',
    ts: new Date().toISOString(),
    host: url.host,
    path: url.path,
    queryValues: url.queryValues,
    payloadSummary: summarizeValue(parsed, {includeGeoValues: config.includeGeoValues}),
    signals: mergeSignals(signals, signalsForUrl(url, 0))
  });
}

function writeEvent(event) {
  const compact = pruneEmpty(event);
  if (compact.kind === 'http') state.counters.http += 1;
  if (compact.kind && compact.kind.startsWith('ws')) state.counters.websocket += 1;
  if (compact.kind === 'resource_snapshot') state.counters.resourceSnapshot += 1;
  if (state.events.length < MAX_EVENTS_IN_MEMORY) state.events.push(compact);
  out.write(`${JSON.stringify(compact)}\n`);
}

function isPureUrl(raw) {
  try {
    const url = new URL(raw);
    return url.hostname === 'pure.app' ||
      url.hostname.endsWith('.pure.app') ||
      url.hostname === 'thepure.app' ||
      url.hostname.endsWith('.thepure.app');
  } catch (_) {
    return false;
  }
}

function sanitizeUrl(raw) {
  const url = new URL(raw);
  return {
    host: url.hostname,
    path: generalizePath(url.pathname || '/'),
    queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
    queryValues: summarizeQueryValues(url.searchParams)
  };
}

function summarizeQueryValues(params) {
  const out = {};
  for (const [key, value] of params.entries()) {
    if (!isGeoKey(key) && !/(city_id|radius)/i.test(key)) continue;
    out[key] = coarseQueryValue(key, value);
  }
  return out;
}

function coarseQueryValue(key, value) {
  const text = String(value || '');
  if (!text) return '';
  if (/city_id/i.test(key)) return /^[0-9]+$/.test(text) ? text : ':id';
  return text.replace(/-?\d+(?:\.\d+)?/g, numberText => {
    const number = Number(numberText);
    if (!Number.isFinite(number)) return numberText;
    if (Math.abs(number) <= 180 && String(numberText).includes('.')) return String(Math.round(number * 10) / 10);
    return String(Math.round(number));
  }).slice(0, 160);
}

function generalizePath(path) {
  const segments = String(path || '/').split('/').map(segment => {
    if (!segment) return segment;
    if (/^chat\.[a-f0-9]{16,}$/i.test(segment)) return 'chat.:id';
    if (/^[a-f0-9]{20,}$/i.test(segment)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':uuid';
    if (/^[A-Za-z0-9_-]{24,}\.(png|jpe?g|webp|gif|mp3|woff2?)$/i.test(segment)) {
      return `:asset.${segment.split('.').pop()}`;
    }
    return segment;
  });
  return segments.join('/') || '/';
}

function summarizeHeaders(headers) {
  const lower = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const name = String(key).toLowerCase();
    if (name === 'content-type') lower.contentType = String(value || '');
    if (name === 'x-ratelimit-limit') lower.rateLimit = normalizeScalar(value);
    if (name === 'x-ratelimit-remaining') lower.rateRemaining = normalizeScalar(value);
    if (name === 'retry-after') lower.retryAfter = normalizeScalar(value);
  }
  return lower;
}

function boundedText(value) {
  const text = String(value || '');
  return text.length > BODY_TEXT_LIMIT ? text.slice(0, BODY_TEXT_LIMIT) : text;
}

function summarizePayloadText(text) {
  if (!text) return null;
  const parsed = parsePayload(text);
  return summarizeValue(parsed, {includeGeoValues: config.includeGeoValues});
}

function parsePayload(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return {_textLength: trimmed.length};
  }
}

async function captureFreshResourceSnapshots() {
  const targets = await fetchJson(`http://${config.host}:${config.port}/json/list`);
  const selected = chooseTargets(targets, config.target).slice(0, 6);
  for (const target of selected) {
    const connection = await connectCdp(target.webSocketDebuggerUrl);
    try {
      await connection.send('Runtime.enable').catch(() => {});
      await captureResourceSnapshot(connection);
    } finally {
      connection.close();
    }
  }
}

async function captureResourceSnapshot(connection) {
  const expression = `(() => performance.getEntriesByType('resource').map(entry => entry.name).concat([location.href]))()`;
  const result = await connection.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false
  });
  const urls = Array.isArray(result.result?.value) ? result.result.value : [];
  const seen = new Set();
  for (const raw of urls) {
    if (!isPureUrl(raw || '')) continue;
    const url = sanitizeUrl(raw);
    const key = `${url.host}${url.path}?${url.queryKeys.join('&')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    writeEvent({
      kind: 'resource_snapshot',
      ts: new Date().toISOString(),
      host: url.host,
      path: url.path,
      queryKeys: url.queryKeys,
      queryValues: url.queryValues,
      signals: signalsForUrl(url, 0)
    });
  }
}

function summarizeValue(value, options = {}, depth = 0, path = []) {
  if (value === null) return {type: 'null'};
  if (value === undefined) return {type: 'undefined'};
  if (Array.isArray(value)) {
    const sample = value.find(item => item !== null && item !== undefined);
    return pruneEmpty({
      type: 'array',
      length: value.length,
      sample: depth < 4 && sample !== undefined ? summarizeValue(sample, options, depth + 1, path.concat('[]')) : null
    });
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => !isSensitiveKey(key)).sort();
    const fields = {};
    for (const key of keys.slice(0, 35)) {
      fields[key] = summarizeValue(value[key], options, depth + 1, path.concat(key));
    }
    return pruneEmpty({
      type: 'object',
      keys,
      fields: depth < 3 ? fields : null,
      hints: classifyKeys(keys)
    });
  }
  return summarizeScalar(value, options, path);
}

function summarizeScalar(value, options, path) {
  const key = String(path[path.length - 1] || '');
  if (typeof value === 'boolean') return {type: 'boolean', value};
  if (typeof value === 'number') {
    if (options.includeGeoValues && isGeoKey(key)) return {type: 'number', coarseValue: coarseNumber(key, value)};
    if (isStateKey(key)) return {type: 'number', value};
    return {type: 'number'};
  }
  if (typeof value === 'string') {
    if (isSensitiveKey(key)) return {type: 'string', length: value.length};
    if (options.includeGeoValues && isGeoKey(key) && value.length <= 80) {
      return {type: 'string', value: normalizeScalar(value)};
    }
    if (isStateKey(key) && value.length <= 80 && !looksPersonalText(value)) {
      return {type: 'string', value: normalizeScalar(value)};
    }
    return {type: 'string', length: value.length};
  }
  return {type: typeof value};
}

function normalizeScalar(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;
  return String(value || '').slice(0, 120);
}

function coarseNumber(key, value) {
  const lower = String(key).toLowerCase();
  if (/lat|lon|lng|coord/.test(lower)) return Math.round(value * 10) / 10;
  if (/distance|radius/.test(lower)) return Math.round(value);
  return Math.round(value * 100) / 100;
}

function looksPersonalText(value) {
  const text = String(value || '');
  return text.length > 80 || /\s/.test(text) && !/^[a-z0-9_.:-]+$/i.test(text);
}

function isSensitiveKey(key) {
  return /(authorization|cookie|token|secret|session|jwt|bearer|password|phone|email|photo|avatar|image|url|uri|name|username|displayname|description|bio|text|message)/i.test(String(key));
}

function isGeoKey(key) {
  return /(geo|location|lat|latitude|lon|lng|longitude|city|country|distance|radius|near|zone|region|coordinate)/i.test(String(key));
}

function isStateKey(key) {
  return /(type|kind|event|action|method|module|status|state|reason|code|error|enabled|visible|visibility|blocked|banned|ban|restricted|restriction|moderation|review|boost|premium|subscription|verified|online|active|counter|count|total|limit|remaining)/i.test(String(key));
}

function classifyKeys(keys) {
  const classes = new Set();
  for (const key of keys) {
    if (isGeoKey(key)) classes.add('geo');
    if (/(visibility|visible|shown|show|shadow|ban|blocked|restricted|moderation|suspended|review|rank|score|boost)/i.test(key)) classes.add('visibility');
    if (/(match|like|reaction|chat|message|feed|search|recommend|profile|user)/i.test(key)) classes.add('engagement');
    if (/(error|code|reason|retry|limit|remaining|throttle)/i.test(key)) classes.add('error-or-rate');
  }
  return [...classes].sort();
}

function extractSignals(value, path, options) {
  const signals = endpointSignals(path, 0);
  const geoFields = new Set();
  const geoValues = [];
  const visibility = [];
  const engagement = [];
  const errors = [];
  const counts = [];
  visit(value, [], (keyPath, key, scalar) => {
    const joined = keyPath.join('.');
    if (isGeoKey(key)) {
      geoFields.add(joined);
      if (options.includeGeoValues && (typeof scalar === 'string' || typeof scalar === 'number' || typeof scalar === 'boolean')) {
        geoValues.push({field: joined, value: coarseSignalValue(key, scalar)});
      }
    }
    if (/(visibility|visible|shown|show|shadow|ban|blocked|restricted|moderation|suspended|review|rank|score|boost)/i.test(key)) {
      visibility.push({field: joined, value: safeSignalValue(key, scalar)});
    }
    if (/(match|like|reaction|chat|feed|search_likes|event|type|action|module)/i.test(key)) {
      engagement.push({field: joined, value: safeSignalValue(key, scalar)});
    }
    if (/(error|code|reason|retry|limit|remaining|throttle)/i.test(key)) {
      errors.push({field: joined, value: safeSignalValue(key, scalar)});
    }
    if (/(count|counter|total|limit|remaining|distance|radius)/i.test(key) && typeof scalar === 'number') {
      counts.push({field: joined, value: coarseNumber(key, scalar)});
    }
  });
  if (geoFields.size) signals.geoFields = [...geoFields].slice(0, 60);
  if (geoValues.length) signals.geoValues = uniqueObjects(geoValues).slice(0, 40);
  if (visibility.length) signals.visibility = uniqueObjects(visibility).slice(0, 40);
  if (engagement.length) signals.engagement = uniqueObjects(engagement).slice(0, 40);
  if (errors.length) signals.errors = uniqueObjects(errors).slice(0, 40);
  if (counts.length) signals.counts = uniqueObjects(counts).slice(0, 40);
  return pruneEmpty(signals);
}

function endpointSignals(path, status) {
  const text = String(path || '').toLowerCase();
  const flags = [];
  if (/feed|recommend|search|profiles|users/.test(text)) flags.push('feed-or-profile');
  if (/search_likes|like|match|reaction/.test(text)) flags.push('like-or-match');
  if (/chat|message|centrifugo|connection|websocket/.test(text)) flags.push('chat-or-ws');
  if (/geo|location|city|country|near|distance|radius/.test(text)) flags.push('geo');
  if (/visibility|moderation|ban|block|restriction|shadow|rank|score|boost/.test(text)) flags.push('visibility');
  if (status === 429) flags.push('rate-limit');
  if (status >= 400) flags.push('http-error');
  return flags.length ? {flags} : {};
}

function signalsForUrl(url, status) {
  const signals = endpointSignals(url.path, status);
  if ((url.queryKeys || []).some(key => isGeoKey(key) || /(city_id|radius)/i.test(key))) {
    signals.flags = [...new Set([...(signals.flags || []), 'geo'])];
    signals.geoValues = Object.entries(url.queryValues || {}).map(([field, value]) => ({
      field: `query.${field}`,
      value
    }));
  }
  return pruneEmpty(signals);
}

function mergeSignals(primary, secondary) {
  if (!primary) return secondary || {};
  if (!secondary) return primary;
  return pruneEmpty({
    ...primary,
    ...secondary,
    flags: [...new Set([...(primary.flags || []), ...(secondary.flags || [])])],
    geoFields: uniqueArray([...(primary.geoFields || []), ...(secondary.geoFields || [])]),
    geoValues: uniqueObjects([...(primary.geoValues || []), ...(secondary.geoValues || [])]),
    visibility: uniqueObjects([...(primary.visibility || []), ...(secondary.visibility || [])]),
    engagement: uniqueObjects([...(primary.engagement || []), ...(secondary.engagement || [])]),
    errors: uniqueObjects([...(primary.errors || []), ...(secondary.errors || [])]),
    counts: uniqueObjects([...(primary.counts || []), ...(secondary.counts || [])])
  });
}

function uniqueArray(values) {
  return [...new Set(values)].filter(Boolean);
}

function visit(value, path, onScalar, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 80)) visit(item, path.concat('[]'), onScalar, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) continue;
      if (child === null || child === undefined) continue;
      if (typeof child === 'object') {
        visit(child, path.concat(key), onScalar, depth + 1);
      } else {
        onScalar(path.concat(key), key, child);
      }
    }
  }
}

function safeSignalValue(key, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return coarseNumber(key, value);
  const text = String(value || '');
  if (!text || text.length > 80 || isSensitiveKey(key) || looksPersonalText(text)) return {type: 'string', length: text.length};
  return text;
}

function coarseSignalValue(key, value) {
  if (typeof value === 'number') return coarseNumber(key, value);
  if (typeof value === 'boolean') return value;
  const text = String(value || '');
  if (!text || text.length > 80 || looksPersonalText(text)) return {type: 'string', length: text.length};
  return text;
}

function uniqueObjects(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function pruneEmpty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null || child === undefined) continue;
    if (Array.isArray(child) && child.length === 0) continue;
    if (typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) continue;
    out[key] = child;
  }
  return out;
}

function buildSummary(reason) {
  const endpointMap = new Map();
  const flagMap = new Map();
  const errors = [];
  const geo = [];
  const visibility = [];
  const engagement = [];
  const statuses = new Map();

  for (const event of state.events) {
    const key = event.kind?.startsWith('ws') ?
      `WS ${event.host}${event.path}` :
      `${event.method || event.kind} ${event.host || ''}${event.path || ''}`.trim();
    if (key) {
      const row = endpointMap.get(key) || {
        endpoint: key,
        count: 0,
        statuses: {},
        flags: new Set(),
        queryKeys: new Set(),
        queryValues: new Map()
      };
      row.count += 1;
      if (event.status) row.statuses[event.status] = (row.statuses[event.status] || 0) + 1;
      for (const flag of event.signals?.flags || []) row.flags.add(flag);
      for (const queryKey of event.queryKeys || []) row.queryKeys.add(queryKey);
      for (const [queryKey, value] of Object.entries(event.queryValues || {})) {
        const values = row.queryValues.get(queryKey) || new Set();
        values.add(String(value));
        row.queryValues.set(queryKey, values);
      }
      endpointMap.set(key, row);
    }
    if (event.status) statuses.set(String(event.status), (statuses.get(String(event.status)) || 0) + 1);
    for (const flag of event.signals?.flags || []) flagMap.set(flag, (flagMap.get(flag) || 0) + 1);
    if (event.status >= 400 || event.kind === 'http_failed' || event.signals?.errors) {
      errors.push(pickEvent(event, ['kind', 'method', 'host', 'path', 'status', 'errorText', 'queryValues', 'signals']));
    }
    if (event.signals?.geoFields || event.signals?.geoValues) geo.push(pickEvent(event, ['kind', 'method', 'host', 'path', 'status', 'queryValues', 'signals']));
    if (event.signals?.visibility) visibility.push(pickEvent(event, ['kind', 'method', 'host', 'path', 'status', 'queryValues', 'signals']));
    if (event.signals?.engagement || event.signals?.flags?.some(flag => /like|match|chat|feed/.test(flag))) {
      engagement.push(pickEvent(event, ['kind', 'method', 'host', 'path', 'status', 'queryValues', 'signals']));
    }
  }

  return {
    runId,
    reason,
    startedAt: state.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    target: state.target,
    files: fileLabels,
    config: {
      host: config.host,
      port: config.port,
      target: config.target,
      durationMs: config.durationMs,
      reload: config.reload,
      includeResponseBodies: config.includeResponseBodies,
      includeGeoValues: config.includeGeoValues
    },
    counters: {
      ...state.counters,
      storedEvents: state.events.length,
      truncatedEventMemory: state.events.length >= MAX_EVENTS_IN_MEMORY
    },
    statuses: Object.fromEntries([...statuses.entries()].sort()),
    flags: Object.fromEntries([...flagMap.entries()].sort((a, b) => b[1] - a[1])),
    endpoints: [...endpointMap.values()]
      .map(row => ({
        endpoint: row.endpoint,
        count: row.count,
        statuses: row.statuses,
        flags: [...row.flags].sort(),
        queryKeys: [...row.queryKeys].sort(),
        queryValues: Object.fromEntries([...row.queryValues.entries()].map(([key, values]) => [key, [...values].sort().slice(0, 8)]))
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 80),
    errors: errors.slice(0, 80),
    geo: geo.slice(0, 80),
    visibility: visibility.slice(0, 80),
    engagement: engagement.slice(0, 80)
  };
}

function pickEvent(event, keys) {
  const out = {};
  for (const key of keys) {
    if (event[key] !== undefined) out[key] = event[key];
  }
  return out;
}

function renderReport(summary) {
  const endpointLines = summary.endpoints.slice(0, 30).map(endpoint => {
    const statuses = Object.keys(endpoint.statuses || {}).length ? ` statuses=${JSON.stringify(endpoint.statuses)}` : '';
    const flags = endpoint.flags.length ? ` flags=${endpoint.flags.join(',')}` : '';
    const query = endpoint.queryKeys.length ? ` queryKeys=${endpoint.queryKeys.join(',')}` : '';
    const queryValues = Object.keys(endpoint.queryValues || {}).length ? ` queryValues=${JSON.stringify(endpoint.queryValues)}` : '';
    return `- ${endpoint.count}x \`${endpoint.endpoint}\`${statuses}${flags}${query}${queryValues}`;
  }).join('\n') || '- No Pure endpoints captured.';

  const errors = summary.errors.slice(0, 20).map(event => {
    return `- \`${event.method || event.kind} ${event.host || ''}${event.path || ''}\` status=${event.status || 'n/a'}${event.errorText ? ` error=${event.errorText}` : ''}`;
  }).join('\n') || '- No HTTP errors/rate-limit responses captured.';

  const geo = summary.geo.slice(0, 20).map(event => {
    const fields = event.signals?.geoFields?.slice(0, 10).join(', ') || '';
    const values = event.signals?.geoValues?.slice(0, 6).map(item => `${item.field}=${JSON.stringify(item.value)}`).join(', ') || '';
    const queryValues = Object.keys(event.queryValues || {}).length ? ` queryValues=${JSON.stringify(event.queryValues)}` : '';
    return `- \`${event.method || event.kind} ${event.host || ''}${event.path || ''}\`${fields ? ` fields=${fields}` : ''}${values ? ` values=${values}` : ''}${queryValues}`;
  }).join('\n') || '- No geo/location fields captured.';

  const visibility = summary.visibility.slice(0, 20).map(event => {
    const values = event.signals?.visibility?.slice(0, 10).map(item => `${item.field}=${JSON.stringify(item.value)}`).join(', ') || '';
    return `- \`${event.method || event.kind} ${event.host || ''}${event.path || ''}\`${values ? ` ${values}` : ''}`;
  }).join('\n') || '- No explicit visibility/moderation/ban fields captured.';

  const engagement = summary.engagement.slice(0, 20).map(event => {
    const flags = event.signals?.flags?.join(',') || '';
    const values = event.signals?.engagement?.slice(0, 8).map(item => `${item.field}=${JSON.stringify(item.value)}`).join(', ') || '';
    return `- \`${event.method || event.kind} ${event.host || ''}${event.path || ''}\`${flags ? ` flags=${flags}` : ''}${values ? ` ${values}` : ''}`;
  }).join('\n') || '- No like/match/chat/feed signals captured.';

  return `# Pure API Listener Report

Started: ${summary.startedAt}
Finished: ${summary.finishedAt}
Target: ${summary.target?.title || ''} ${summary.target?.url || ''}
Captured: ${summary.counters.http} HTTP events, ${summary.counters.websocket} WebSocket events

## Top Endpoints

${endpointLines}

## Errors And Rate Limits

${errors}

## Geo / Location Signals

${geo}

## Visibility / Moderation Signals

${visibility}

## Feed / Like / Match / Chat Signals

${engagement}

## Interpretation Notes

- This listener records endpoint structure, statuses, JSON keys, coarse geo values, counters, and short enum-like state values.
- It intentionally does not store authorization headers, cookies, profile text, messages, names, image URLs, or exact identifiers.
- A shadowban cannot be proven from one client-side capture alone. Stronger evidence would be repeated captures showing normal feed access but no inbound like/match/chat events, plus no explicit HTTP errors, restrictions, moderation states, or rate limits.
- Geo mismatch is more directly testable: look for self/profile/location endpoints with city/coordinate/radius fields and compare the coarse values with the expected Moscow area.
`;
}
