import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let cachedModule = null;
let cachedSpecifier = null;

function moduleSpecifier(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('..')) {
    return pathToFileURL(resolve(specifier)).href;
  }
  return specifier;
}

function validateAdapter(adapter, policy) {
  if (!adapter || typeof adapter.snapshot !== 'function') {
    throw new Error('Configured trading adapter must expose snapshot()');
  }
  if (typeof adapter.broker !== 'string' || !adapter.broker.trim()) {
    throw new Error('Configured trading adapter must declare a broker string');
  }
  if (!policy.configured_broker) {
    throw new Error('TV_TRADING_BROKER must explicitly bind this server to one broker adapter');
  }
  if (adapter.broker !== policy.configured_broker) {
    throw new Error(
      `Configured adapter broker ${adapter.broker} does not match TV_TRADING_BROKER ${policy.configured_broker}`,
    );
  }
  return adapter;
}

/** Load exactly one explicitly configured adapter for this server process. */
export async function configuredAdapter(policy, deps = {}) {
  if (deps.adapter) return validateAdapter(deps.adapter, policy);
  if (!policy.adapter_module) {
    throw new Error('TV_TRADING_ADAPTER_MODULE must explicitly configure a broker adapter module');
  }
  if (!cachedModule || cachedSpecifier !== policy.adapter_module) {
    const imported = await import(moduleSpecifier(policy.adapter_module));
    cachedModule = imported.default || imported.adapter || imported;
    cachedSpecifier = policy.adapter_module;
  }
  return validateAdapter(cachedModule, policy);
}

