import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { configuredAdapter } from '../trading/adapter.js';
import { FileIdempotencyStore, defaultIdempotencyRoot } from '../trading/idempotency-store.js';
import {
  SERVER_EXECUTION_POLICY,
  assertMutationPolicy,
  executionPolicyFromEnv,
} from '../trading/policy.js';
import * as alertEvents from './alert-events.js';

const TERMINAL_ORDER_STATUSES = ['filled', 'cancelled', 'canceled', 'rejected', 'expired'];
const accountLocks = new Map();

function failure(stage, message, extra = {}) {
  return { success: false, stage, error: message, state_changed: false, ...extra };
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${field} is required`), { stage: 'input_validation' });
  return value.trim();
}

function canonicalize(value, path = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key], `${path}.${key}`)]));
  }
  throw new Error(`${path} contains unsupported JSON value ${typeof value}`);
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function sortEntities(values, kind) {
  if (!Array.isArray(values)) throw new Error(`${kind} must be an array`);
  const normalized = values.map((value, index) => {
    const entry = canonicalize(value, `${kind}[${index}]`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${kind}[${index}] must be an object`);
    if (entry.id == null || !String(entry.id).trim()) throw new Error(`${kind}[${index}].id is required`);
    return entry;
  });
  normalized.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (let index = 1; index < normalized.length; index++) {
    if (String(normalized[index - 1].id) === String(normalized[index].id)) {
      throw new Error(`${kind} contains duplicate id ${normalized[index].id}`);
    }
  }
  return normalized;
}

export function normalizeAccountSnapshot(raw, policy, now = () => new Date().toISOString()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Adapter snapshot must be an object');
  for (const field of ['balances', 'orders', 'positions']) {
    if (!Object.hasOwn(raw, field)) throw new Error(`Adapter snapshot must include ${field}`);
  }
  const source = raw.account || {};
  const account = {
    broker: requireText(source.broker, 'account.broker'),
    account_id: requireText(source.account_id, 'account.account_id'),
    account_type: requireText(source.account_type, 'account.account_type'),
    connected: source.connected === true,
    is_simulation: source.is_simulation === true,
    ...(source.simulation_evidence != null && { simulation_evidence: String(source.simulation_evidence) }),
  };
  const orders = sortEntities(raw.orders, 'orders');
  const positions = sortEntities(raw.positions, 'positions');
  const balances = canonicalize(raw.balances, 'balances');
  const derivedState = canonicalize({ balances, orders, positions }, 'current_state');
  const currentState = raw.current_state == null
    ? derivedState
    : canonicalize(raw.current_state, 'current_state');
  if (!currentState || typeof currentState !== 'object' || Array.isArray(currentState)) {
    throw new Error('current_state must be an object');
  }
  if (raw.current_state != null) {
    for (const field of ['balances', 'orders', 'positions']) {
      if (stableStringify(currentState[field]) !== stableStringify(derivedState[field])) {
        throw new Error(`current_state.${field} must exactly match the canonical snapshot ${field}`);
      }
    }
  }
  return {
    schema_version: 1,
    observed_at: raw.observed_at || (typeof now === 'function'
      ? now()
      : new Date(now ?? Date.now()).toISOString()),
    server_execution_profile: policy.profile,
    account,
    balances,
    orders,
    positions,
    current_state: currentState,
    state_token: digest(currentState),
  };
}

async function withAccountLock(key, task) {
  const previous = accountLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  accountLocks.set(key, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (accountLocks.get(key) === current) accountLocks.delete(key);
  }
}

function nowValue(deps) {
  return typeof deps?.now === 'function' ? deps.now() : undefined;
}

function guardInput(args, mutation = false) {
  const expected = {
    expected_broker: requireText(args.expected_broker, 'expected_broker'),
    expected_account_id: requireText(args.expected_account_id, 'expected_account_id'),
    expected_account_type: requireText(args.expected_account_type, 'expected_account_type'),
  };
  if (mutation) {
    expected.expected_execution_profile = requireText(args.expected_execution_profile, 'expected_execution_profile');
    expected.approval_id = requireText(args.approval_id, 'approval_id');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,199}$/.test(expected.approval_id)) {
      throw Object.assign(new Error('approval_id must be 6-200 safe identifier characters'), { stage: 'input_validation' });
    }
    if (!args.expected_current_state || typeof args.expected_current_state !== 'object' || Array.isArray(args.expected_current_state)) {
      throw Object.assign(new Error('expected_current_state must be the complete object from trading_account_snapshot'), { stage: 'input_validation' });
    }
    expected.expected_current_state = canonicalize(args.expected_current_state, 'expected_current_state');
  }
  return expected;
}

function assertIdentity(snapshot, expected) {
  const account = snapshot.account;
  if (account.broker !== expected.expected_broker
    || account.account_id !== expected.expected_account_id
    || account.account_type !== expected.expected_account_type) {
    throw Object.assign(new Error(
      `Observed account ${account.broker}/${account.account_id}/${account.account_type} does not exactly match the expected identity`,
    ), { stage: 'account_identity_validation' });
  }
  if (!account.connected) {
    throw Object.assign(new Error('The exact expected account is not connected'), { stage: 'account_connection_validation' });
  }
}

function assertExactState(snapshot, expectedState) {
  if (stableStringify(snapshot.current_state) !== stableStringify(expectedState)) {
    throw Object.assign(new Error('Current account state does not exactly match expected_current_state'), {
      stage: 'current_state_validation',
      expected_state_token: digest(expectedState),
      observed_state_token: snapshot.state_token,
    });
  }
}

function assertMutationTarget(operation, snapshot, payload) {
  if (operation === 'order_cancel' || operation === 'order_replace') {
    if (!snapshot.orders.some(order => String(order.id) === payload.order_id)) {
      throw Object.assign(new Error(`Order ${payload.order_id} is not present in the exact current state`), {
        stage: 'mutation_target_validation',
      });
    }
  }
  if (operation === 'position_close'
    && !snapshot.positions.some(position => String(position.id) === payload.position_id)) {
    throw Object.assign(new Error(`Position ${payload.position_id} is not present in the exact current state`), {
      stage: 'mutation_target_validation',
    });
  }
}

async function context(args = {}) {
  const policy = resolvePolicy(args._deps);
  const adapter = await configuredAdapter(policy, args._deps);
  return { policy, adapter };
}

function resolvePolicy(deps) {
  if (deps?.policy) return deps.policy;
  if (deps && Object.hasOwn(deps, 'env')) return executionPolicyFromEnv(deps.env);
  return SERVER_EXECUTION_POLICY;
}

async function snapshotFor(args, expected) {
  const { policy, adapter } = await context(args);
  if (!policy.configured_broker || policy.configured_broker !== expected.expected_broker) {
    throw Object.assign(new Error('Expected broker is not the explicitly configured server broker'), { stage: 'broker_routing_validation' });
  }
  const snapshot = normalizeAccountSnapshot(await adapter.snapshot({ expected_account: expected }), policy, args._deps?.now);
  assertIdentity(snapshot, expected);
  return { policy, adapter, snapshot };
}

export async function accountSnapshot(args = {}) {
  try {
    const expected = guardInput(args);
    const { snapshot } = await snapshotFor(args, expected);
    return { success: true, state_changed: false, ...snapshot };
  } catch (err) {
    return failure(err.stage || 'snapshot', err.message);
  }
}

export async function alertWaitSnapshot(args = {}) {
  try {
    const expected = guardInput(args);
    const waitForAlert = args._deps?.waitForAlert || alertEvents.wait;
    const eventResult = await waitForAlert({
      alert_plan_id: args.alert_plan_id,
      messages: args.messages,
      after: args.after,
      timeout_seconds: args.timeout_seconds,
      _deps: args._deps?.alertEventDeps,
    });
    if (!eventResult.success) return failure('alert_wait', eventResult.error?.message || eventResult.error);
    if (eventResult.timed_out) return { success: true, action: 'timeout', timed_out: true, event: null, snapshot: null, state_changed: false };
    const { snapshot } = await snapshotFor(args, expected);
    return { success: true, action: 'event', timed_out: false, event: eventResult.event, snapshot, state_changed: false };
  } catch (err) {
    return failure(err.stage || 'alert_wait_snapshot', err.message);
  }
}

function validateOrder(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) throw new Error('order must be an object');
  const normalized = canonicalize(order, 'order');
  normalized.symbol = requireText(normalized.symbol, 'order.symbol');
  normalized.side = requireText(normalized.side, 'order.side').toLowerCase();
  normalized.type = requireText(normalized.type, 'order.type').toLowerCase();
  normalized.time_in_force = requireText(normalized.time_in_force, 'order.time_in_force');
  normalized.quantity = Number(normalized.quantity);
  if (!['buy', 'sell'].includes(normalized.side)) throw new Error('order.side must be buy or sell');
  if (!['market', 'limit', 'stop', 'stop_limit'].includes(normalized.type)) throw new Error('order.type must be market, limit, stop, or stop_limit');
  if (!Number.isFinite(normalized.quantity) || normalized.quantity <= 0) throw new Error('order.quantity must be positive');
  if (['limit', 'stop_limit'].includes(normalized.type) && (!Number.isFinite(normalized.limit_price) || normalized.limit_price <= 0)) {
    throw new Error('order.limit_price must be positive for limit and stop_limit orders');
  }
  if (['stop', 'stop_limit'].includes(normalized.type) && (!Number.isFinite(normalized.stop_price) || normalized.stop_price <= 0)) {
    throw new Error('order.stop_price must be positive for stop and stop_limit orders');
  }
  return normalized;
}

async function idempotencyStore(args, policy) {
  return args._deps?.idempotencyStore || new FileIdempotencyStore(defaultIdempotencyRoot(policy));
}

async function replayRecord(store, approvalId, fingerprint) {
  const record = await store.get(approvalId);
  if (!record) return null;
  if (record.fingerprint !== fingerprint) return failure('idempotency_conflict', 'approval_id was already used for a different exact request');
  if (record.status !== 'completed') return failure('idempotency_in_progress', 'approval_id has a pending or indeterminate mutation');
  return { ...record.result, idempotent_replay: true };
}

async function guardedMutation(operation, method, args, payload) {
  try {
    const expected = guardInput(args, true);
    const policy = resolvePolicy(args._deps);
    if (expected.expected_execution_profile !== policy.profile || policy.profile === 'read-only') {
      assertMutationPolicy(policy, expected, { is_simulation: false });
    }
    const adapter = await configuredAdapter(policy, args._deps);
    if (typeof adapter[method] !== 'function') return failure('adapter_capability', `Configured adapter does not support ${method}()`);
    const request = { operation, expected, payload };
    const fingerprint = digest(request);
    const store = await idempotencyStore(args, policy);
    const replay = await replayRecord(store, expected.approval_id, fingerprint);
    if (replay) return replay;

    const accountKey = `${expected.expected_broker}\0${expected.expected_account_id}\0${expected.expected_account_type}`;
    return await withAccountLock(accountKey, async () => {
      const lockedReplay = await replayRecord(store, expected.approval_id, fingerprint);
      if (lockedReplay) return lockedReplay;

      const before = normalizeAccountSnapshot(await adapter.snapshot({ expected_account: expected }), policy, args._deps?.now);
      assertIdentity(before, expected);
      assertMutationPolicy(policy, expected, before.account);
      assertExactState(before, expected.expected_current_state);
      assertMutationTarget(operation, before, payload);

      const begun = await store.begin(expected.approval_id, fingerprint, operation, nowValue(args._deps));
      if (!begun.created) return await replayRecord(store, expected.approval_id, fingerprint);

      let result;
      try {
        const adapter_result = await adapter[method](payload, {
          approval_id: expected.approval_id,
          expected_account: expected,
          expected_current_state: expected.expected_current_state,
          execution_profile: policy.profile,
        });
        const after = normalizeAccountSnapshot(await adapter.snapshot({ expected_account: expected }), policy, args._deps?.now);
        assertIdentity(after, expected);
        result = {
          success: true,
          action: operation,
          approval_id: expected.approval_id,
          idempotent_replay: false,
          state_changed: before.state_token !== after.state_token,
          before_state_token: before.state_token,
          after_snapshot: after,
          adapter_result: canonicalize(adapter_result ?? {}, 'adapter_result'),
        };
      } catch (err) {
        let after = null;
        try {
          after = normalizeAccountSnapshot(await adapter.snapshot({ expected_account: expected }), policy, args._deps?.now);
          assertIdentity(after, expected);
        } catch {}
        result = failure('adapter_mutation', err.message, {
          approval_id: expected.approval_id,
          mutation_outcome: 'indeterminate',
          state_changed: after ? before.state_token !== after.state_token : null,
          ...(after && { after_snapshot: after }),
        });
      }
      await store.complete(expected.approval_id, fingerprint, result, nowValue(args._deps));
      return result;
    });
  } catch (err) {
    return failure(err.stage || 'guard_validation', err.message, {
      ...(err.expected_state_token && { expected_state_token: err.expected_state_token }),
      ...(err.observed_state_token && { observed_state_token: err.observed_state_token }),
    });
  }
}

export async function orderSubmitGuarded(args = {}) {
  try {
    return await guardedMutation('order_submit', 'submitOrder', args, { order: validateOrder(args.order) });
  } catch (err) {
    return failure('input_validation', err.message);
  }
}

export async function orderCancelGuarded(args = {}) {
  try {
    return await guardedMutation('order_cancel', 'cancelOrder', args, { order_id: requireText(args.order_id, 'order_id') });
  } catch (err) {
    return failure('input_validation', err.message);
  }
}

export async function orderReplaceGuarded(args = {}) {
  try {
    const replacement = canonicalize(args.replacement, 'replacement');
    if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement) || !Object.keys(replacement).length) {
      throw new Error('replacement must be a non-empty object');
    }
    return await guardedMutation('order_replace', 'replaceOrder', args, {
      order_id: requireText(args.order_id, 'order_id'), replacement,
    });
  } catch (err) {
    return failure('input_validation', err.message);
  }
}

export async function positionCloseGuarded(args = {}) {
  try {
    const payload = { position_id: requireText(args.position_id, 'position_id') };
    if (args.quantity != null) {
      payload.quantity = Number(args.quantity);
      if (!Number.isFinite(payload.quantity) || payload.quantity <= 0) throw new Error('quantity must be positive');
    }
    return await guardedMutation('position_close', 'closePosition', args, payload);
  } catch (err) {
    return failure('input_validation', err.message);
  }
}

export async function orderWait(args = {}) {
  try {
    const expected = guardInput(args);
    const orderId = requireText(args.order_id, 'order_id');
    const statuses = (args.statuses?.length ? args.statuses : TERMINAL_ORDER_STATUSES).map(value => requireText(value, 'statuses').toLowerCase());
    const timeout = args.timeout_seconds == null ? 30 : Number(args.timeout_seconds);
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 55) throw new Error('timeout_seconds must be from 0 through 55');
    const deadline = Date.now() + timeout * 1000;
    let snapshot;
    do {
      ({ snapshot } = await snapshotFor(args, expected));
      const order = snapshot.orders.find(entry => String(entry.id) === orderId) || null;
      if (order && statuses.includes(String(order.status || '').toLowerCase())) {
        return { success: true, action: 'order', timed_out: false, order, snapshot, state_changed: false };
      }
      if (Date.now() >= deadline) return { success: true, action: 'timeout', timed_out: true, order, snapshot, state_changed: false };
      await (args._deps?.delay || delay)(Math.min(250, Math.max(1, deadline - Date.now())));
    } while (true);
  } catch (err) {
    return failure(err.stage || 'order_wait', err.message);
  }
}
