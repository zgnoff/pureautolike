import {createGatewayControl} from './gateway-control.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

const PRIVACY_URL = 'https://zgnme.github.io/pureautolike/privacy/';
const gatewayControl = createGatewayControl();

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return corsResponse(null, 204);
    const url = new URL(request.url);

    try {
      const gatewayResponse = await gatewayControl.handle(request, env);
      if (gatewayResponse) return gatewayResponse;

      if ((request.method === 'GET' || request.method === 'HEAD') && (url.pathname === '/privacy' || url.pathname === '/privacy.html')) {
        return Response.redirect(PRIVACY_URL, 301);
      }

      if (request.method === 'GET' && url.pathname === '/v1/config') {
        return corsJson({
          beta_enabled: betaEnabled(env),
          checkout_enabled: !!env.CHECKOUT_URL
        });
      }

      if (request.method === 'POST' && url.pathname === '/v1/install/bootstrap') {
        const body = await readJson(request);
        return corsJson(await bootstrapInstall(env, body));
      }

      if (request.method === 'POST' && url.pathname === '/v1/license/check') {
        const body = await readJson(request);
        return corsJson(await checkLicense(env, body));
      }

      if (request.method === 'POST' && url.pathname === '/v1/billing/checkout') {
        const body = await readJson(request);
        return corsJson(await createCheckout(env, body), env.CHECKOUT_URL ? 200 : 503);
      }

      if (request.method === 'POST' && url.pathname === '/v1/billing/webhook') {
        const body = await readJson(request);
        return corsJson(await billingWebhook(env, request, body));
      }

      return corsJson({ok: false, error: 'not_found'}, 404);
    } catch (error) {
      return corsJson({ok: false, error: error.message || String(error)}, 500);
    }
  }
};

function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...JSON_HEADERS,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-PureAutoLike-Webhook'
    }
  });
}

function corsJson(payload, status = 200) {
  return corsResponse(JSON.stringify(payload), status);
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) return {};
  return request.json();
}

function betaEnabled(env) {
  return String(env.BETA_ENABLED || 'true').toLowerCase() !== 'false';
}

function nowIso() {
  return new Date().toISOString();
}

function nextCheckIso(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function allowedExtension(env, extensionId) {
  const allowed = String(env.ALLOWED_EXTENSION_IDS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  return !allowed.length || allowed.includes(extensionId);
}

function publicLicense(payload) {
  return {
    ok: true,
    access: !!payload.access,
    mode: payload.mode,
    plan: payload.plan,
    label: payload.label,
    beta: !!payload.beta,
    reason: payload.reason || '',
    checkout_url: payload.checkout_url || '',
    checked_at: nowIso(),
    next_check_at: payload.next_check_at || nextCheckIso()
  };
}

async function bootstrapInstall(env, body) {
  const installationId = String(body.installation_id || randomId('pal_install'));
  const extensionId = String(body.extension_id || '');
  const version = String(body.version || '');
  const channel = String(body.channel || 'chrome-web-store');
  if (!allowedExtension(env, extensionId)) {
    return publicLicense({
      access: false,
      mode: 'blocked',
      plan: 'none',
      label: 'LOCKED',
      beta: false,
      reason: 'extension_not_allowed',
      next_check_at: nextCheckIso(1)
    });
  }
  await upsertInstallation(env, {installationId, extensionId, version, channel});
  return {
    ok: true,
    installation_id: installationId,
    license: await checkLicense(env, {...body, installation_id: installationId})
  };
}

async function checkLicense(env, body) {
  const installationId = String(body.installation_id || '');
  const extensionId = String(body.extension_id || '');
  const version = String(body.version || '');
  const channel = String(body.channel || 'chrome-web-store');

  if (!installationId) {
    return publicLicense({
      access: false,
      mode: 'blocked',
      plan: 'none',
      label: 'LOCKED',
      beta: false,
      reason: 'missing_installation_id',
      next_check_at: nextCheckIso(1)
    });
  }

  if (!allowedExtension(env, extensionId)) {
    await recordLicenseCheck(env, {installationId, extensionId, version, result: 'blocked', reason: 'extension_not_allowed'});
    return publicLicense({
      access: false,
      mode: 'blocked',
      plan: 'none',
      label: 'LOCKED',
      beta: false,
      reason: 'extension_not_allowed',
      next_check_at: nextCheckIso(1)
    });
  }

  await upsertInstallation(env, {installationId, extensionId, version, channel});

  if (betaEnabled(env)) {
    await recordLicenseCheck(env, {installationId, extensionId, version, result: 'beta', reason: 'beta_enabled'});
    return publicLicense({
      access: true,
      mode: 'beta',
      plan: 'beta',
      label: 'BETA',
      beta: true,
      reason: 'beta_enabled'
    });
  }

  const entitlement = await activeEntitlement(env, body);
  if (entitlement) {
    await recordLicenseCheck(env, {installationId, extensionId, version, result: 'active', reason: entitlement.plan});
    return publicLicense({
      access: true,
      mode: 'paid',
      plan: entitlement.plan,
      label: entitlement.plan.toUpperCase(),
      beta: false,
      reason: 'subscription_active',
      next_check_at: nextCheckIso(12)
    });
  }

  await recordLicenseCheck(env, {installationId, extensionId, version, result: 'denied', reason: 'subscription_required'});
  return publicLicense({
    access: false,
    mode: 'paid',
    plan: 'none',
    label: 'LOCKED',
    beta: false,
    reason: 'subscription_required',
    checkout_url: env.CHECKOUT_URL || '',
    next_check_at: nextCheckIso(1)
  });
}

async function upsertInstallation(env, item) {
  if (!env.DB) return;
  await env.DB.prepare(`
    INSERT INTO installations (id, extension_id, version, channel, first_seen_at, last_seen_at, status)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'active')
    ON CONFLICT(id) DO UPDATE SET
      extension_id = excluded.extension_id,
      version = excluded.version,
      channel = excluded.channel,
      last_seen_at = CURRENT_TIMESTAMP
  `).bind(item.installationId, item.extensionId, item.version, item.channel).run();
}

async function recordLicenseCheck(env, item) {
  if (!env.DB) return;
  await env.DB.prepare(`
    INSERT INTO license_checks (id, installation_id, extension_id, version, result, reason, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(randomId('pal_check'), item.installationId, item.extensionId, item.version, item.result, item.reason || '').run();
}

async function activeEntitlement(env, body) {
  if (!env.DB) return null;
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return null;
  return env.DB.prepare(`
    SELECT e.plan, e.status, e.valid_until
    FROM users u
    JOIN entitlements e ON e.user_id = u.id
    WHERE u.email = ?
      AND e.status = 'active'
      AND (e.valid_until IS NULL OR e.valid_until > CURRENT_TIMESTAMP)
    ORDER BY e.updated_at DESC
    LIMIT 1
  `).bind(email).first();
}

async function createCheckout(env, body) {
  if (!env.CHECKOUT_URL) {
    return {
      ok: false,
      reason: 'checkout_not_configured'
    };
  }
  const url = new URL(env.CHECKOUT_URL);
  if (body.installation_id) url.searchParams.set('installation_id', String(body.installation_id));
  if (body.email) url.searchParams.set('email', String(body.email));
  return {
    ok: true,
    checkout_url: url.toString()
  };
}

async function billingWebhook(env, request, body) {
  const expected = String(env.WEBHOOK_SECRET || '');
  if (!expected) return {ok: false, reason: 'webhook_not_configured'};
  const actual = request.headers.get('X-PureAutoLike-Webhook') || '';
  if (actual !== expected) return {ok: false, reason: 'invalid_webhook_secret'};

  return {
    ok: true,
    received: true,
    event_type: String(body.type || 'unknown')
  };
}
