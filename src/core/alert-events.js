import {
  acknowledgeEvent,
  eventStoreHealth,
  eventStoreRoot,
  waitForEvent,
} from '../webhook/event-store.js';


function requireOptionalText(value, field) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}


function validateFilters({ alert_plan_id, messages, after, timeout_seconds } = {}) {
  const planId = requireOptionalText(alert_plan_id, 'alert_plan_id');
  if (messages != null && (!Array.isArray(messages) || messages.length > 64)) {
    throw new Error('messages must be an array with at most 64 entries');
  }
  const normalizedMessages = messages?.map((message, index) => requireOptionalText(message, `messages[${index}]`));
  if (!planId && !normalizedMessages?.length) {
    throw new Error('Provide alert_plan_id or at least one exact message');
  }
  let normalizedAfter;
  if (after != null) {
    normalizedAfter = requireOptionalText(after, 'after');
    if (!Number.isFinite(Date.parse(normalizedAfter))) throw new Error('after must be an ISO-8601 timestamp');
    normalizedAfter = new Date(normalizedAfter).toISOString();
  }
  const timeout = timeout_seconds == null ? 30 : Number(timeout_seconds);
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 55) {
    throw new Error('timeout_seconds must be from 0 through 55');
  }
  return {
    filters: { alert_plan_id: planId, messages: normalizedMessages, after: normalizedAfter },
    timeout,
  };
}


export async function health({ _deps } = {}) {
  const root = _deps?.root || eventStoreRoot();
  const now = typeof _deps?.now === 'function' ? _deps.now() : (_deps?.now ?? Date.now());
  const result = await eventStoreHealth({ root, now });
  return { success: true, ...result };
}


export async function wait(args = {}) {
  try {
    const { filters, timeout } = validateFilters(args);
    const root = args._deps?.root || eventStoreRoot();
    const result = await waitForEvent(filters, {
      root,
      timeoutSeconds: timeout,
      now: args._deps?.now || (() => Date.now()),
    });
    return {
      success: true,
      action: result.timed_out ? 'timeout' : 'event',
      timed_out: result.timed_out,
      event: result.event,
      state_changed: false,
    };
  } catch (err) {
    return { success: false, error: err.message, state_changed: false };
  }
}


export async function ack({ event_id, _deps } = {}) {
  try {
    const id = requireOptionalText(event_id, 'event_id');
    const root = _deps?.root || eventStoreRoot();
    const result = await acknowledgeEvent(id, { root });
    return { success: true, ...result, state_changed: !result.already_acknowledged };
  } catch (err) {
    return { success: false, error: err.message, state_changed: false };
  }
}
