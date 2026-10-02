export const EXECUTION_PROFILES = Object.freeze([
  'read-only',
  'paper-only',
  'live-enabled',
]);

const LIVE_CONFIRMATION = 'ENABLE_LIVE_ORDER_EXECUTION';

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolve the immutable server-side execution policy from explicit process
 * configuration. No browser, broker connection, or caller argument can
 * promote this policy.
 */
export function executionPolicyFromEnv(env = process.env) {
  const profile = optionalText(env.TV_TRADING_EXECUTION_PROFILE) || 'read-only';
  if (!EXECUTION_PROFILES.includes(profile)) {
    throw new Error(`TV_TRADING_EXECUTION_PROFILE must be one of: ${EXECUTION_PROFILES.join(', ')}`);
  }

  const policy = {
    profile,
    configured_broker: optionalText(env.TV_TRADING_BROKER),
    adapter_module: optionalText(env.TV_TRADING_ADAPTER_MODULE),
    idempotency_dir: optionalText(env.TV_TRADING_IDEMPOTENCY_DIR),
    live: null,
  };

  if (profile === 'live-enabled') {
    const confirmation = optionalText(env.TV_TRADING_LIVE_CONFIRMATION);
    const broker = optionalText(env.TV_TRADING_LIVE_BROKER);
    const accountId = optionalText(env.TV_TRADING_LIVE_ACCOUNT_ID);
    const accountType = optionalText(env.TV_TRADING_LIVE_ACCOUNT_TYPE);
    if (confirmation !== LIVE_CONFIRMATION || !broker || !accountId || !accountType) {
      throw new Error(
        'live-enabled requires separate explicit TV_TRADING_LIVE_CONFIRMATION, '
        + 'TV_TRADING_LIVE_BROKER, TV_TRADING_LIVE_ACCOUNT_ID, and '
        + 'TV_TRADING_LIVE_ACCOUNT_TYPE configuration',
      );
    }
    if (policy.configured_broker !== broker) {
      throw new Error(
        'TV_TRADING_LIVE_BROKER must exactly match the separately configured TV_TRADING_BROKER',
      );
    }
    policy.live = Object.freeze({
      broker,
      account_id: accountId,
      account_type: accountType,
    });
  }

  return Object.freeze(policy);
}

// Production tools use one policy resolved at module/server startup. Tests and
// library consumers can still inject an explicit policy into the core calls.
export const SERVER_EXECUTION_POLICY = executionPolicyFromEnv();

export function assertMutationPolicy(policy, expected, account) {
  if (expected.expected_execution_profile !== policy.profile) {
    throw Object.assign(new Error(
      `Expected execution profile ${expected.expected_execution_profile}, but server is ${policy.profile}`,
    ), { stage: 'execution_profile_validation' });
  }
  if (policy.profile === 'read-only') {
    throw Object.assign(new Error('Server execution profile is read-only; every trading mutation is rejected'), {
      stage: 'execution_profile_validation',
    });
  }
  if (!policy.configured_broker || expected.expected_broker !== policy.configured_broker) {
    throw Object.assign(new Error(
      `Expected broker ${expected.expected_broker} is not the explicitly configured server broker`,
    ), { stage: 'broker_routing_validation' });
  }

  if (policy.profile === 'paper-only' && account.is_simulation !== true) {
    throw Object.assign(new Error(
      'paper-only requires the adapter to positively identify the account as a simulation account',
    ), { stage: 'simulation_account_validation' });
  }

  if (policy.profile === 'live-enabled') {
    const live = policy.live;
    if (!live
      || live.broker !== expected.expected_broker
      || live.account_id !== expected.expected_account_id
      || live.account_type !== expected.expected_account_type) {
      throw Object.assign(new Error(
        'The expected account does not match the separately configured live-enabled account binding',
      ), { stage: 'live_account_binding_validation' });
    }
  }
}
