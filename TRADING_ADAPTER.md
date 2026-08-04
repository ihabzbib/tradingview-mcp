# Structured trading adapter contract

The trading MCP tools are broker-agnostic policy and concurrency controls. A
broker implementation is loaded only from the explicit
`TV_TRADING_ADAPTER_MODULE` server setting. The MCP never searches connected
accounts for somewhere to route an order. The resolved profile is frozen when
the server process starts; caller arguments and later adapter/browser state
cannot promote it.

## Server configuration

The safe default is `read-only`. The supervised paper-trading deployment uses:

```json
{
  "env": {
    "TV_TRADING_EXECUTION_PROFILE": "paper-only",
    "TV_TRADING_BROKER": "tradingview-paper",
    "TV_TRADING_ADAPTER_MODULE": "/absolute/path/to/tradingview-paper-adapter.js",
    "TV_TRADING_IDEMPOTENCY_DIR": "/absolute/private/path/trading-idempotency"
  }
}
```

`paper-only` accepts a mutation only when the adapter snapshot sets
`account.is_simulation` to the boolean `true`. An account name containing
“paper”, a caller assertion, or merely being connected is not sufficient.

`live-enabled` is intentionally not activated by the profile alone. It also
requires the following separate settings, all bound to one exact account:

```text
TV_TRADING_LIVE_CONFIRMATION=ENABLE_LIVE_ORDER_EXECUTION
TV_TRADING_LIVE_BROKER=...
TV_TRADING_LIVE_ACCOUNT_ID=...
TV_TRADING_LIVE_ACCOUNT_TYPE=...
```

Do not put those live settings in a paper-trading server configuration.

## Adapter module

The configured ES module exports an adapter as its default export (or as
`adapter`). It must declare `broker`, implement `snapshot`, and implement only
the mutations it supports:

```js
export default {
  broker: 'tradingview-paper',

  async snapshot({ expected_account }) {
    return {
      observed_at: new Date().toISOString(),
      account: {
        broker: 'tradingview-paper',
        account_id: 'approved-account-id',
        account_type: 'paper',
        connected: true,
        is_simulation: true,
        simulation_evidence: 'positive broker API classification'
      },
      balances: {},
      orders: [{ id: 'order-id', status: 'working' }],
      positions: [{ id: 'position-id', symbol: 'NASDAQ:NVDA', quantity: 1 }]
    };
  },

  async submitOrder({ order }, guardContext) {},
  async cancelOrder({ order_id }, guardContext) {},
  async replaceOrder({ order_id, replacement }, guardContext) {},
  async closePosition({ position_id, quantity }, guardContext) {}
};
```

Every order and position must have a unique, stable `id`. All three of
`balances`, `orders`, and `positions` are required. The MCP canonicalizes them
into `current_state`; alternatively an adapter can supply its own complete
`current_state` object with additional broker state, but its `balances`,
`orders`, and `positions` fields must exactly match those canonical snapshot
fields. The caller must return that entire object unchanged as
`expected_current_state` on a mutation.

The MCP verifies the state again while holding an in-process per-account lock.
It also passes the exact expected identity, profile, approval ID, and expected
state in `guardContext`. An adapter backed by a transactional broker API should
repeat the state/version check atomically with its mutation, since changes can
also originate outside this MCP process.

`expected_account` and `guardContext.expected_account` are verification and
routing constraints, never instructions to connect, select, or switch a UI
account. The adapter must address that exact broker-native account directly or
reject the operation. It must not fall back to a currently selected or merely
connected account.

## Approval and retry semantics

`approval_id` is both the human/supervisor approval reference and the
idempotency key. Records are written privately before the adapter mutation.

- Replaying the exact request returns the stored result without a second
  broker call.
- Reusing the ID with any different guard, state, or payload is rejected.
- A pending record or an adapter error is never automatically retried. The
  outcome is reported as indeterminate until reconciled with a fresh snapshot.

The default idempotency directory is
`~/.tradingview-mcp/trading-idempotency`; set an explicit private absolute path
for supervised deployments.
