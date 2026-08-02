import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as events from '../src/core/alert-events.js';
import { registerAlertEventTools } from '../src/tools/alert-events.js';
import { eventIdFor, eventStoreHealth, listPending } from '../src/webhook/event-store.js';
import { createWebhookServer } from '../src/webhook/server.js';


const resources = [];


async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tradingview-webhook-test-'));
  const server = createWebhookServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      path: '/tradingview/alerts',
      max_body_bytes: options.maxBody || 1024,
      event_store: root,
    },
    now: options.now || (() => Date.parse('2026-08-03T13:42:03Z')),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  resources.push({ root, server });
  return { root, server, url: `http://127.0.0.1:${server.address().port}/tradingview/alerts` };
}


afterEach(async () => {
  while (resources.length) {
    const { root, server } = resources.pop();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});


describe('TradingView webhook receiver', () => {
  it('durably queues and deduplicates deterministic text alerts', async () => {
    const { root, url } = await fixture();
    const message = 'DT|2026-08-03|NASDAQ:NVDA|orb|1|INITIAL_ORB';
    const first = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: message,
    });
    assert.equal(first.status, 202);
    const accepted = await first.json();
    assert.equal(accepted.event_id, eventIdFor(message));
    assert.equal(accepted.duplicate, false);

    const repeated = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: message,
    });
    assert.equal((await repeated.json()).duplicate, true);
    const pending = await listPending({ messages: [message] }, { root });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].message, message);
  });

  it('filters JSON events by approved plan and acknowledges idempotently', async () => {
    const { root, url } = await fixture();
    const payload = {
      schema_version: 1,
      event: 'supervised_alert',
      alert_plan_id: 'plan-123',
      alert_key: 'NASDAQ_NVDA_1_INITIAL_ORB',
      triggered_at: '2026-08-03T09:42:00-04:00',
    };
    const raw = JSON.stringify(payload);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: raw,
    });
    assert.equal(response.status, 202);

    const found = await events.wait({
      alert_plan_id: 'plan-123',
      timeout_seconds: 0,
      _deps: { root },
    });
    assert.equal(found.success, true);
    assert.equal(found.action, 'event');
    assert.equal(found.event.payload.alert_key, payload.alert_key);
    assert.equal(found.event.triggered_at, '2026-08-03T13:42:00.000Z');

    const acked = await events.ack({ event_id: found.event.event_id, _deps: { root } });
    assert.equal(acked.success, true);
    assert.equal(acked.state_changed, true);
    const repeated = await events.ack({ event_id: found.event.event_id, _deps: { root } });
    assert.equal(repeated.success, true);
    assert.equal(repeated.state_changed, false);
  });

  it('wakes a long wait when the receiver queues an event', async () => {
    const { root, url } = await fixture({ now: () => Date.now() });
    const message = 'DT|wake-test';
    const waiting = events.wait({ messages: [message], timeout_seconds: 2, _deps: { root } });
    await new Promise(resolve => setTimeout(resolve, 25));
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: message,
    });
    const result = await waiting;
    assert.equal(result.action, 'event');
    assert.equal(result.event.message, message);
  });

  it('rejects unsupported content types, empty bodies, oversized bodies, and unknown routes', async () => {
    const { url, server } = await fixture({ maxBody: 8 });
    const unsupported = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'alert',
    });
    assert.equal(unsupported.status, 400);
    const empty = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '' });
    assert.equal(empty.status, 400);
    const oversized = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '123456789',
    });
    assert.equal(oversized.status, 413);
    const missing = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    assert.equal(missing.status, 404);
  });

  it('reports a recent receiver heartbeat and private spool permissions', async () => {
    const { root } = await fixture();
    await new Promise(resolve => setTimeout(resolve, 20));
    const health = await eventStoreHealth({ root, now: Date.parse('2026-08-03T13:42:03Z') });
    assert.equal(health.receiver_recent, true);
    assert.equal(health.directory_mode, '700');
  });
});


describe('webhook MCP contracts', () => {
  it('registers health, wait, and acknowledgement tools', () => {
    const registrations = [];
    registerAlertEventTools({
      tool(name, description, schema, handler) {
        registrations.push({ name, description, schema, handler });
      },
    });
    assert.deepEqual(
      registrations.map(tool => tool.name),
      ['webhook_health', 'alert_event_wait', 'alert_event_ack'],
    );
    assert.deepEqual(
      Object.keys(registrations.find(tool => tool.name === 'alert_event_wait').schema),
      ['alert_plan_id', 'messages', 'after', 'timeout_seconds'],
    );
  });

  it('requires an approved plan ID or exact messages and caps waits at 55 seconds', async () => {
    assert.equal((await events.wait({ timeout_seconds: 0 })).success, false);
    assert.equal((await events.wait({ messages: ['exact'], timeout_seconds: 56 })).success, false);
  });
});
