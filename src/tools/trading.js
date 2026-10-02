import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/trading.js';

const accountGuardShape = {
  expected_broker: z.string().describe('Exact broker bound in server configuration'),
  expected_account_id: z.string().describe('Exact approved broker account ID'),
  expected_account_type: z.string().describe('Exact approved account type'),
};

const mutationGuardShape = {
  ...accountGuardShape,
  expected_execution_profile: z.enum(['read-only', 'paper-only', 'live-enabled'])
    .describe('Exact execution profile the caller expects the server to enforce'),
  approval_id: z.string().min(6).max(200)
    .describe('Unique approval and idempotency ID; reuse only to replay this exact request'),
  expected_current_state: z.record(z.any())
    .describe('Complete current_state object from the immediately preceding account snapshot'),
};

const orderSchema = z.object({
  symbol: z.string().describe('Broker canonical symbol'),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit', 'stop', 'stop_limit']),
  quantity: z.number().positive(),
  time_in_force: z.string().describe('Explicit broker time-in-force, for example day'),
  limit_price: z.number().positive().optional(),
  stop_price: z.number().positive().optional(),
  extended_hours: z.boolean().optional(),
  client_order_id: z.string().optional(),
  bracket: z.record(z.any()).optional(),
}).passthrough();

function register(server, name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    // `_deps` exists only on the core API's direct test/library boundary. Drop
    // it explicitly here even if an SDK/schema version preserves unknown keys.
    const publicArgs = { ...args };
    delete publicArgs._deps;
    const result = await handler(publicArgs);
    return jsonResult(result, !result.success);
  });
}

export function registerTradingTools(server) {
  register(
    server,
    'trading_account_snapshot',
    'Read one explicitly configured broker/account snapshot. Returns canonical current_state and state_token for guarded mutations; never selects or changes an account.',
    accountGuardShape,
    core.accountSnapshot,
  );

  register(
    server,
    'trading_alert_wait_snapshot',
    'Wait for one exact durable alert event, then read the explicitly expected broker/account snapshot. Does not acknowledge the alert or mutate trading state.',
    {
      ...accountGuardShape,
      alert_plan_id: z.string().optional(),
      messages: z.array(z.string()).max(64).optional(),
      after: z.string().optional(),
      timeout_seconds: z.coerce.number().min(0).max(55).optional(),
    },
    core.alertWaitSnapshot,
  );

  register(
    server,
    'trading_order_submit_guarded',
    'Submit one structured order only after server profile, exact account identity, simulation/live binding, approval idempotency, and complete current-state guards pass.',
    { ...mutationGuardShape, order: orderSchema },
    core.orderSubmitGuarded,
  );

  register(
    server,
    'trading_order_wait',
    'Wait up to 55 seconds for an order on the explicitly expected broker/account to reach one of the requested statuses. Read-only.',
    {
      ...accountGuardShape,
      order_id: z.string(),
      statuses: z.array(z.string()).max(32).optional(),
      timeout_seconds: z.coerce.number().min(0).max(55).optional(),
    },
    core.orderWait,
  );

  register(
    server,
    'trading_order_cancel_guarded',
    'Cancel one exact order only after all server policy, identity, approval/idempotency, and complete current-state guards pass.',
    { ...mutationGuardShape, order_id: z.string() },
    core.orderCancelGuarded,
  );

  register(
    server,
    'trading_order_replace_guarded',
    'Replace one exact order only after all server policy, identity, approval/idempotency, and complete current-state guards pass.',
    { ...mutationGuardShape, order_id: z.string(), replacement: z.record(z.any()) },
    core.orderReplaceGuarded,
  );

  register(
    server,
    'trading_position_close_guarded',
    'Close all or an explicit quantity of one position only after all server policy, identity, approval/idempotency, and complete current-state guards pass.',
    { ...mutationGuardShape, position_id: z.string(), quantity: z.number().positive().optional() },
    core.positionCloseGuarded,
  );
}
