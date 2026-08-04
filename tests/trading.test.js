import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountSnapshot,
  alertWaitSnapshot,
  orderCancelGuarded,
  orderReplaceGuarded,
  orderSubmitGuarded,
  orderWait,
  positionCloseGuarded,
} from '../src/core/trading.js';
import { executionPolicyFromEnv } from '../src/trading/policy.js';
import { configuredAdapter } from '../src/trading/adapter.js';
import { defaultIdempotencyRoot } from '../src/trading/idempotency-store.js';
import { registerTradingTools } from '../src/tools/trading.js';

function policy(profile = 'paper-only', overrides = {}) {
  return {
    profile,
    configured_broker: 'mock-broker',
    adapter_module: null,
    idempotency_dir: null,
    live: null,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    account: {
      broker: 'mock-broker',
      account_id: 'paper-123',
      account_type: 'paper',
      connected: true,
      is_simulation: true,
      simulation_evidence: 'broker API account classification',
      ...overrides.account,
    },
    balances: { equity: 50000, buying_power: 50000 },
    orders: overrides.orders || [],
    positions: overrides.positions || [],
  };
}

function adapter(initial = snapshot()) {
  let state = structuredClone(initial);
  const calls = { submit: 0, cancel: 0, replace: 0, close: 0, snapshots: 0 };
  return {
    broker: 'mock-broker',
    calls,
    async snapshot() { calls.snapshots++; return structuredClone(state); },
    async submitOrder({ order }) {
      calls.submit++;
      state.orders.push({ id: 'order-1', status: 'working', ...order });
      return { order_id: 'order-1' };
    },
    async cancelOrder({ order_id }) {
      calls.cancel++;
      state.orders = state.orders.map(order => order.id === order_id ? { ...order, status: 'cancelled' } : order);
    },
    async replaceOrder() { calls.replace++; },
    async closePosition() { calls.close++; },
  };
}

class MemoryStore {
  records = new Map();
  async get(id) { return this.records.get(id) || null; }
  async begin(id, fingerprint, operation) {
    if (this.records.has(id)) return { created: false, record: this.records.get(id) };
    const record = { approval_id: id, fingerprint, operation, status: 'pending' };
    this.records.set(id, record);
    return { created: true, record };
  }
  async complete(id, fingerprint, result) {
    const record = { ...this.records.get(id), fingerprint, status: 'completed', result };
    this.records.set(id, record);
    return record;
  }
}

const identity = {
  expected_broker: 'mock-broker',
  expected_account_id: 'paper-123',
  expected_account_type: 'paper',
};

const order = {
  symbol: 'NASDAQ:NVDA',
  side: 'buy',
  type: 'limit',
  quantity: 1,
  time_in_force: 'day',
  limit_price: 123.45,
};

async function guardedArgs(mock, approval = 'approval-001', profileOverride = policy()) {
  const baseDeps = { adapter: mock, policy: profileOverride, idempotencyStore: new MemoryStore() };
  const current = await accountSnapshot({ ...identity, _deps: baseDeps });
  return {
    ...identity,
    expected_execution_profile: profileOverride.profile,
    approval_id: approval,
    expected_current_state: current.current_state,
    order,
    _deps: baseDeps,
  };
}

describe('server execution policy', () => {
  it('defaults to read-only and requires separate complete live configuration', () => {
    assert.equal(executionPolicyFromEnv({}).profile, 'read-only');
    assert.throws(
      () => executionPolicyFromEnv({ TV_TRADING_EXECUTION_PROFILE: 'live-enabled' }),
      /separate explicit/,
    );
    const live = executionPolicyFromEnv({
      TV_TRADING_EXECUTION_PROFILE: 'live-enabled',
      TV_TRADING_BROKER: 'mock-broker',
      TV_TRADING_LIVE_CONFIRMATION: 'ENABLE_LIVE_ORDER_EXECUTION',
      TV_TRADING_LIVE_BROKER: 'mock-broker',
      TV_TRADING_LIVE_ACCOUNT_ID: 'live-1',
      TV_TRADING_LIVE_ACCOUNT_TYPE: 'margin',
    });
    assert.deepEqual(live.live, { broker: 'mock-broker', account_id: 'live-1', account_type: 'margin' });
    assert.equal(Object.isFrozen(live.live), true);
    assert.throws(
      () => executionPolicyFromEnv({
        TV_TRADING_EXECUTION_PROFILE: 'live-enabled',
        TV_TRADING_BROKER: 'other-broker',
        TV_TRADING_LIVE_CONFIRMATION: 'ENABLE_LIVE_ORDER_EXECUTION',
        TV_TRADING_LIVE_BROKER: 'mock-broker',
        TV_TRADING_LIVE_ACCOUNT_ID: 'live-1',
        TV_TRADING_LIVE_ACCOUNT_TYPE: 'margin',
      }),
      /must exactly match/,
    );
  });

  it('preserves adapter module and idempotency directory from environment', () => {
    const policy = executionPolicyFromEnv({
      TV_TRADING_EXECUTION_PROFILE: 'paper-only',
      TV_TRADING_BROKER: 'mock-broker',
      TV_TRADING_ADAPTER_MODULE: '/absolute/path/to/adapter.js',
      TV_TRADING_IDEMPOTENCY_DIR: '/tmp/trading-idempotency',
    });
    assert.equal(policy.adapter_module, '/absolute/path/to/adapter.js');
    assert.equal(policy.idempotency_dir, '/tmp/trading-idempotency');
  });

  it('uses the configured idempotency directory as the store root', () => {
    assert.equal(
      defaultIdempotencyRoot({ idempotency_dir: '/tmp/trading-idempotency' }),
      '/tmp/trading-idempotency',
    );
    assert.match(defaultIdempotencyRoot({ idempotency_dir: null }), /trading-idempotency$/);
  });
});

describe('adapter binding', () => {
  it('requires explicit adapter module when broker is configured and no dependency override is passed', async () => {
    const policy = executionPolicyFromEnv({
      TV_TRADING_EXECUTION_PROFILE: 'paper-only',
      TV_TRADING_BROKER: 'mock-broker',
    });
    await assert.rejects(() => configuredAdapter(policy), /TV_TRADING_ADAPTER_MODULE/);
  });

  it('uses an explicitly injected adapter dependency', async () => {
    const policy = executionPolicyFromEnv({
      TV_TRADING_EXECUTION_PROFILE: 'paper-only',
      TV_TRADING_BROKER: 'mock-broker',
      TV_TRADING_ADAPTER_MODULE: '/absolute/path/to/ignored.js',
    });
    const adapter = { broker: 'mock-broker', snapshot() { return {}; } };
    const resolved = await configuredAdapter(policy, { adapter });
    assert.equal(resolved, adapter);
  });
});

describe('account snapshots and guarded mutations', () => {
  it('returns canonical state only for the exact configured identity', async () => {
    const mock = adapter();
    const result = await accountSnapshot({ ...identity, _deps: { adapter: mock, policy: policy() } });
    assert.equal(result.success, true);
    assert.equal(result.server_execution_profile, 'paper-only');
    assert.equal(result.account.is_simulation, true);
    assert.equal(result.state_token.length, 64);

    const wrong = await accountSnapshot({ ...identity, expected_account_id: 'other', _deps: { adapter: mock, policy: policy() } });
    assert.equal(wrong.success, false);
    assert.equal(wrong.stage, 'account_identity_validation');
  });

  it('rejects incomplete or ambiguous adapter state', async () => {
    const incomplete = adapter({
      ...snapshot(),
      current_state: { balances: {}, orders: [], positions: [] },
    });
    const mismatch = await accountSnapshot({ ...identity, _deps: { adapter: incomplete, policy: policy() } });
    assert.equal(mismatch.success, false);
    assert.match(mismatch.error, /current_state\.balances/);

    const duplicate = adapter(snapshot({ orders: [
      { id: 'same-id', status: 'working' },
      { id: 'same-id', status: 'filled' },
    ] }));
    const ambiguous = await accountSnapshot({ ...identity, _deps: { adapter: duplicate, policy: policy() } });
    assert.equal(ambiguous.success, false);
    assert.match(ambiguous.error, /duplicate id/);
  });

  it('rejects every mutation in read-only before calling the adapter mutation', async () => {
    const mock = adapter();
    const args = await guardedArgs(mock, 'approval-readonly', policy('read-only'));
    const result = await orderSubmitGuarded(args);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'execution_profile_validation');
    assert.equal(mock.calls.submit, 0);
  });

  it('paper-only requires positive simulation identification', async () => {
    const mock = adapter(snapshot({ account: { is_simulation: false } }));
    const args = await guardedArgs(mock, 'approval-not-paper');
    const result = await orderSubmitGuarded(args);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'simulation_account_validation');
    assert.equal(mock.calls.submit, 0);
  });

  it('rejects stale expected state before mutation', async () => {
    const mock = adapter();
    const args = await guardedArgs(mock, 'approval-stale');
    args.expected_current_state = { balances: {}, orders: [], positions: [] };
    const result = await orderSubmitGuarded(args);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'current_state_validation');
    assert.equal(mock.calls.submit, 0);
  });

  it('submits once and replays the exact result for the same approval ID', async () => {
    const mock = adapter();
    const args = await guardedArgs(mock, 'approval-submit-once');
    const first = await orderSubmitGuarded(args);
    assert.equal(first.success, true);
    assert.equal(first.idempotent_replay, false);
    assert.equal(mock.calls.submit, 1);
    const repeated = await orderSubmitGuarded(args);
    assert.equal(repeated.success, true);
    assert.equal(repeated.idempotent_replay, true);
    assert.equal(mock.calls.submit, 1);
  });

  it('rejects reusing an approval ID for a different request', async () => {
    const mock = adapter();
    const args = await guardedArgs(mock, 'approval-conflict');
    assert.equal((await orderSubmitGuarded(args)).success, true);
    const conflict = await orderSubmitGuarded({ ...args, order: { ...order, quantity: 2 } });
    assert.equal(conflict.success, false);
    assert.equal(conflict.stage, 'idempotency_conflict');
    assert.equal(mock.calls.submit, 1);
  });

  it('applies the same complete guard set to cancel', async () => {
    const mock = adapter(snapshot({ orders: [{ id: 'order-1', status: 'working' }] }));
    const args = await guardedArgs(mock, 'approval-cancel');
    const result = await orderCancelGuarded({ ...args, order_id: 'order-1' });
    assert.equal(result.success, true);
    assert.equal(mock.calls.cancel, 1);
    assert.equal(result.after_snapshot.orders[0].status, 'cancelled');
  });

  it('rejects a mutation target that is absent from the exact current state', async () => {
    const mock = adapter();
    const args = await guardedArgs(mock, 'approval-missing-target');
    const result = await orderCancelGuarded({ ...args, order_id: 'missing-order' });
    assert.equal(result.success, false);
    assert.equal(result.stage, 'mutation_target_validation');
    assert.equal(mock.calls.cancel, 0);
  });

  it('applies the guard path to replace and position close', async () => {
    const mock = adapter(snapshot({
      orders: [{ id: 'order-1', status: 'working' }],
      positions: [{ id: 'position-1', symbol: 'NASDAQ:NVDA', quantity: 2 }],
    }));
    const replaceArgs = await guardedArgs(mock, 'approval-replace');
    const replaced = await orderReplaceGuarded({
      ...replaceArgs,
      order_id: 'order-1',
      replacement: { limit_price: 124.5 },
    });
    assert.equal(replaced.success, true);
    assert.equal(mock.calls.replace, 1);

    const closeArgs = await guardedArgs(mock, 'approval-close');
    const closed = await positionCloseGuarded({
      ...closeArgs,
      position_id: 'position-1',
      quantity: 1,
    });
    assert.equal(closed.success, true);
    assert.equal(mock.calls.close, 1);
  });

  it('requires an exact separately configured live account binding', async () => {
    const mock = adapter(snapshot({ account: {
      account_id: 'live-1',
      account_type: 'margin',
      is_simulation: false,
    } }));
    const livePolicy = policy('live-enabled', {
      live: { broker: 'mock-broker', account_id: 'other-live-account', account_type: 'margin' },
    });
    const liveIdentity = {
      expected_broker: 'mock-broker',
      expected_account_id: 'live-1',
      expected_account_type: 'margin',
    };
    const deps = { adapter: mock, policy: livePolicy, idempotencyStore: new MemoryStore() };
    const current = await accountSnapshot({ ...liveIdentity, _deps: deps });
    const args = {
      ...liveIdentity,
      expected_execution_profile: 'live-enabled',
      approval_id: 'approval-live-binding',
      expected_current_state: current.current_state,
      order,
      _deps: deps,
    };
    const result = await orderSubmitGuarded(args);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'live_account_binding_validation');
    assert.equal(mock.calls.submit, 0);
  });
});

describe('trading waits and MCP contract', () => {
  it('waits read-only for an order status on the exact account', async () => {
    const mock = adapter(snapshot({ orders: [{ id: 'order-1', status: 'filled' }] }));
    const result = await orderWait({
      ...identity, order_id: 'order-1', timeout_seconds: 0,
      _deps: { adapter: mock, policy: policy() },
    });
    assert.equal(result.action, 'order');
    assert.equal(result.order.status, 'filled');
  });

  it('takes a snapshot only after a matching alert arrives', async () => {
    const mock = adapter();
    const result = await alertWaitSnapshot({
      ...identity,
      alert_plan_id: 'plan-1',
      _deps: {
        adapter: mock,
        policy: policy(),
        waitForAlert: async () => ({ success: true, timed_out: false, event: { event_id: 'evt-1' } }),
      },
    });
    assert.equal(result.action, 'event');
    assert.equal(result.event.event_id, 'evt-1');
    assert.equal(result.snapshot.account.account_id, 'paper-123');
  });

  it('registers the seven structured tools in the requested order', () => {
    const registered = [];
    registerTradingTools({ tool(name, description, schema) { registered.push({ name, description, schema }); } });
    assert.deepEqual(registered.map(entry => entry.name), [
      'trading_account_snapshot',
      'trading_alert_wait_snapshot',
      'trading_order_submit_guarded',
      'trading_order_wait',
      'trading_order_cancel_guarded',
      'trading_order_replace_guarded',
      'trading_position_close_guarded',
    ]);
    for (const name of [
      'trading_order_submit_guarded', 'trading_order_cancel_guarded',
      'trading_order_replace_guarded', 'trading_position_close_guarded',
    ]) {
      const keys = Object.keys(registered.find(entry => entry.name === name).schema);
      for (const guard of [
        'expected_broker', 'expected_account_id', 'expected_account_type',
        'expected_execution_profile', 'approval_id', 'expected_current_state',
      ]) assert.ok(keys.includes(guard), `${name} missing ${guard}`);
    }
  });
});
