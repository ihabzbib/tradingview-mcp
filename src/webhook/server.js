#!/usr/bin/env node

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { enqueueEvent, eventIdFor, eventStoreRoot, writeHeartbeat } from './event-store.js';


const DEFAULT_MAX_BODY = 16 * 1024;


function integerEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}


export function receiverConfig(env = process.env) {
  const route = env.TV_WEBHOOK_PATH || '/tradingview/alerts';
  if (!route.startsWith('/') || route.includes('?') || route.includes('#')) {
    throw new Error('TV_WEBHOOK_PATH must be an absolute path without query or fragment');
  }
  return {
    host: env.TV_WEBHOOK_HOST || '127.0.0.1',
    port: integerEnv(env.TV_WEBHOOK_PORT, 8787),
    path: route,
    max_body_bytes: integerEnv(env.TV_WEBHOOK_MAX_BODY_BYTES, DEFAULT_MAX_BODY),
    event_store: eventStoreRoot(env),
  };
}


function contentType(request) {
  return String(request.headers['content-type'] || 'text/plain').split(';', 1)[0].trim().toLowerCase();
}


function parsePayload(rawBody, type) {
  if (!rawBody.trim()) throw new Error('Webhook body cannot be empty');
  if (type === 'application/json') {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON webhook body must be an object');
    }
    return parsed;
  }
  if (type !== 'text/plain') throw new Error('Webhook content type must be application/json or text/plain');
  return null;
}


function acceptedEvent(request, rawBody, type, now) {
  const payload = parsePayload(rawBody, type);
  const receivedAt = new Date(now).toISOString();
  const triggeredAt = payload?.triggered_at && Number.isFinite(Date.parse(payload.triggered_at))
    ? new Date(payload.triggered_at).toISOString()
    : receivedAt;
  return {
    event_id: eventIdFor(rawBody),
    received_at: receivedAt,
    triggered_at: triggeredAt,
    content_type: type,
    message: rawBody,
    payload,
    alert_plan_id: typeof payload?.alert_plan_id === 'string' ? payload.alert_plan_id : null,
    alert_key: typeof payload?.alert_key === 'string' ? payload.alert_key : null,
    source_ip: request.socket.remoteAddress || null,
    forwarded_for_untrusted: String(request.headers['x-forwarded-for'] || '').slice(0, 512) || null,
  };
}


async function readBody(request, maximum) {
  return new Promise((resolveBody, rejectBody) => {
    let bytes = 0;
    let tooLarge = false;
    const chunks = [];
    request.on('data', chunk => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > maximum) {
        tooLarge = true;
        rejectBody(Object.assign(new Error('Webhook body is too large'), { statusCode: 413 }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectBody);
  });
}


export function createWebhookServer({
  config = receiverConfig(),
  now = () => Date.now(),
} = {}) {
  let heartbeatTimer = null;
  const heartbeat = () => writeHeartbeat({
    pid: process.pid,
    host: config.host,
    port: server.address()?.port ?? config.port,
    path: config.path,
    started_at: server.startedAt,
    updated_at: new Date(now()).toISOString(),
  }, { root: config.event_store }).catch(() => {});

  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== config.path) {
      response.writeHead(404).end();
      return;
    }
    try {
      const type = contentType(request);
      const rawBody = await readBody(request, config.max_body_bytes);
      const event = acceptedEvent(request, rawBody, type, now());
      const queued = await enqueueEvent(event, { root: config.event_store });
      await heartbeat();
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: true, event_id: queued.event_id, duplicate: queued.duplicate }));
    } catch (err) {
      if (!response.headersSent) {
        response.writeHead(err.statusCode || 400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ accepted: false, error: err.message }));
      }
    }
  });

  server.startedAt = new Date(now()).toISOString();
  server.on('listening', () => {
    heartbeat();
    heartbeatTimer = setInterval(heartbeat, 15_000);
    heartbeatTimer.unref();
  });
  server.on('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });
  return server;
}


export async function startWebhookReceiver(options = {}) {
  const config = options.config || receiverConfig(options.env);
  const server = createWebhookServer({ ...options, config });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, config.host, resolveListen);
  });
  const address = server.address();
  // Receiver diagnostics go only to stderr; the public URL and alert contents
  // are never logged.
  process.stderr.write(
    `TradingView webhook receiver listening on http://${config.host}:${address.port}${config.path}\n`,
  );
  return server;
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receiver = await startWebhookReceiver();
  const close = () => receiver.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
