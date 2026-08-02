import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import {
  access,
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';


const EVENT_ID_RE = /^[a-f0-9]{64}$/;


export function eventStoreRoot(env = process.env) {
  return resolve(env.TV_WEBHOOK_EVENT_DIR || join(homedir(), '.tradingview-mcp', 'webhook-events'));
}


function paths(root) {
  return {
    pending: join(root, 'pending'),
    processed: join(root, 'processed'),
    temporary: join(root, 'tmp'),
    heartbeat: join(root, 'receiver.json'),
  };
}


export async function ensureEventStore(root = eventStoreRoot()) {
  const target = paths(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all([
    mkdir(target.pending, { recursive: true, mode: 0o700 }),
    mkdir(target.processed, { recursive: true, mode: 0o700 }),
    mkdir(target.temporary, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(root, 0o700),
    chmod(target.pending, 0o700),
    chmod(target.processed, 0o700),
    chmod(target.temporary, 0o700),
  ]);
  return target;
}


export function eventIdFor(rawBody) {
  return createHash('sha256').update(String(rawBody), 'utf8').digest('hex');
}


function publicEvent(event) {
  return {
    event_id: event.event_id,
    received_at: event.received_at,
    triggered_at: event.triggered_at,
    content_type: event.content_type,
    message: event.message,
    payload: event.payload,
    alert_plan_id: event.alert_plan_id,
    alert_key: event.alert_key,
    source_ip: event.source_ip,
    forwarded_for_untrusted: event.forwarded_for_untrusted,
  };
}


export async function enqueueEvent(event, { root = eventStoreRoot() } = {}) {
  const target = await ensureEventStore(root);
  const eventId = event.event_id || eventIdFor(event.message);
  if (!EVENT_ID_RE.test(eventId)) throw new Error('event_id must be a SHA-256 hex digest');
  const normalized = { schema_version: 1, ...event, event_id: eventId };
  const finalPath = join(target.pending, `${eventId}.json`);
  const processedPath = join(target.processed, `${eventId}.json`);
  try {
    await access(finalPath);
    return { event_id: eventId, duplicate: true, state: 'pending' };
  } catch {}
  try {
    await access(processedPath);
    return { event_id: eventId, duplicate: true, state: 'processed' };
  } catch {}

  const tempPath = join(target.temporary, `${eventId}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(normalized)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await link(tempPath, finalPath);
    return { event_id: eventId, duplicate: false, state: 'pending' };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return { event_id: eventId, duplicate: true, state: 'pending' };
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}


async function readEventsFrom(directory) {
  let names = [];
  try {
    names = await readdir(directory);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const name of names.filter(item => EVENT_ID_RE.test(basename(item, '.json')) && item.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(await readFile(join(directory, name), 'utf8'));
      events.push(parsed);
    } catch {
      // An invalid spool entry is never returned as a trusted alert event.
    }
  }
  return events.sort((left, right) => (
    Date.parse(left.received_at || '') - Date.parse(right.received_at || '')
    || String(left.event_id).localeCompare(String(right.event_id))
  ));
}


function matches(event, { alert_plan_id, messages, after } = {}) {
  if (alert_plan_id && event.alert_plan_id !== alert_plan_id) return false;
  if (messages?.length && !messages.includes(event.message)) return false;
  if (after && Date.parse(event.received_at) <= Date.parse(after)) return false;
  return true;
}


export async function listPending(filters = {}, { root = eventStoreRoot() } = {}) {
  const target = await ensureEventStore(root);
  const events = await readEventsFrom(target.pending);
  return events.filter(event => matches(event, filters)).map(publicEvent);
}


export async function acknowledgeEvent(eventId, { root = eventStoreRoot() } = {}) {
  if (!EVENT_ID_RE.test(String(eventId))) throw new Error('event_id must be a SHA-256 hex digest');
  const target = await ensureEventStore(root);
  const pendingPath = join(target.pending, `${eventId}.json`);
  const processedPath = join(target.processed, `${eventId}.json`);
  try {
    await rename(pendingPath, processedPath);
    return { event_id: eventId, action: 'acknowledged', already_acknowledged: false };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    await access(processedPath);
    return { event_id: eventId, action: 'already_acknowledged', already_acknowledged: true };
  } catch {
    throw new Error(`Unknown webhook event_id: ${eventId}`);
  }
}


function waitForChange(directory, timeoutMs) {
  return new Promise(resolveWait => {
    let settled = false;
    let timer;
    let watcher;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      resolveWait();
    };
    try {
      watcher = watch(directory, finish);
    } catch {
      watcher = null;
    }
    timer = setTimeout(finish, timeoutMs);
  });
}


export async function waitForEvent(filters = {}, {
  root = eventStoreRoot(),
  timeoutSeconds = 30,
  now = () => Date.now(),
} = {}) {
  const target = await ensureEventStore(root);
  const deadline = now() + timeoutSeconds * 1000;
  while (true) {
    const events = await listPending(filters, { root });
    if (events.length) return { event: events[0], timed_out: false };
    const remaining = deadline - now();
    if (remaining <= 0) return { event: null, timed_out: true };
    await waitForChange(target.pending, Math.min(remaining, 1000));
  }
}


export async function writeHeartbeat(data, { root = eventStoreRoot() } = {}) {
  const target = await ensureEventStore(root);
  const temp = join(target.temporary, `receiver.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(data)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target.heartbeat);
}


export async function eventStoreHealth({ root = eventStoreRoot(), now = Date.now() } = {}) {
  const target = await ensureEventStore(root);
  const [pending, processed] = await Promise.all([
    readEventsFrom(target.pending),
    readEventsFrom(target.processed),
  ]);
  let heartbeat = null;
  try {
    heartbeat = JSON.parse(await readFile(target.heartbeat, 'utf8'));
  } catch {}
  const heartbeatAgeMs = heartbeat?.updated_at ? now - Date.parse(heartbeat.updated_at) : null;
  let directoryMode = null;
  try {
    directoryMode = (await stat(root)).mode & 0o777;
  } catch {}
  return {
    event_store: root,
    pending_count: pending.length,
    processed_count: processed.length,
    receiver: heartbeat,
    heartbeat_age_ms: heartbeatAgeMs,
    receiver_recent: heartbeatAgeMs != null && heartbeatAgeMs >= 0 && heartbeatAgeMs <= 45_000,
    directory_mode: directoryMode == null ? null : directoryMode.toString(8),
  };
}
