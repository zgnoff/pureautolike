import {pathToFileURL} from 'node:url';

import {loadConfig} from './config.js';
import {ConnectorManager} from './connector-manager.js';
import {createControlClient} from './control-client.js';

const POLL_INTERVAL_MS = 5_000;

function delay(milliseconds, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, {once: true});
  });
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : 'GATEWAY_CYCLE_FAILED';
}

export async function runGateway(options = {}) {
  const config = options.config || loadConfig();
  const client = options.client || createControlClient({
    controlPlaneUrl: config.controlPlaneUrl,
    gatewayId: config.gatewayId,
    hmacSecret: config.hmacSecret
  });
  const manager = options.manager || new ConnectorManager({
    privateJwk: config.privateJwk,
    keyId: config.gatewayKeyId
  });
  const signal = options.signal;
  const intervalMs = Math.max(100, Number(options.pollIntervalMs) || POLL_INTERVAL_MS);

  while (!signal?.aborted) {
    try {
      const leases = await client.pollLeases();
      const connectors = await manager.reconcile(leases);
      await client.heartbeat(connectors);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({event: 'gateway_cycle_failed', code: safeErrorCode(error)})}\n`);
    }
    if (!signal?.aborted) await delay(intervalMs, signal);
  }
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await runGateway({signal: controller.signal});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({event: 'gateway_fatal', code: safeErrorCode(error)})}\n`);
    process.exitCode = 1;
  });
}
