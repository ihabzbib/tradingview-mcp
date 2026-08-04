// TradingView Paper Trading Adapter
// Reads/writes TradingView Paper Trading state via Chrome DevTools Protocol

import { evaluate } from './src/connection.js';

const BROKER = 'tradingview-paper';
const ACCOUNT_ID = 'ihab_zbib-paper';
const ACCOUNT_TYPE = 'paper';

// ── Helper: Read DOM text from selector ───────────────
async function readDOM(selector) {
  try {
    return await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? el.textContent.trim() : null;
      })()
    `);
  } catch {
    return null;
  }
}

// ── Helper: Extract balance from paper trading panel ──
function assertExpectedAccount(expectedAccount) {
  if (!expectedAccount || typeof expectedAccount !== 'object') {
    throw new Error('snapshot() requires expected_account context');
  }
  if (expectedAccount.expected_broker !== BROKER) {
    throw new Error(`snapshot() expected broker ${expectedAccount.expected_broker || 'unknown'} does not match ${BROKER}`);
  }
  if (expectedAccount.expected_account_id !== ACCOUNT_ID) {
    throw new Error(`snapshot() expected account_id ${expectedAccount.expected_account_id || 'unknown'} does not match ${ACCOUNT_ID}`);
  }
  if (expectedAccount.expected_account_type !== ACCOUNT_TYPE) {
    throw new Error(`snapshot() expected account_type ${expectedAccount.expected_account_type || 'unknown'} does not match ${ACCOUNT_TYPE}`);
  }
}

async function getBalance() {
  // Try various selectors where balance might appear
  const selectors = [
    '[data-name="account-balance-value"]',
    '.accountBalanceValue',
    '[class*="balance"]',
    '[class*="equity"]',
  ];
  for (const sel of selectors) {
    const text = await readDOM(sel);
    if (text) {
      const num = parseFloat(text.replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(num)) return num;
    }
  }
  // Fallback: try to find any text that looks like a dollar amount in the bottom panel
  const panelTexts = await evaluate(`
    (() => {
      const panel = document.querySelector('[data-name="bottom-widgetbar"]') || document.querySelector('[class*="bottomPanel"]');
      if (!panel) return [];
      return Array.from(panel.querySelectorAll('*'))
        .map(el => el.textContent.trim())
        .filter(t => t.startsWith('$') && !isNaN(parseFloat(t.replace(/[^0-9.-]/g, ''))))
        .slice(0, 10);
    })()
  `);
  const numericPanelTexts = await evaluate(`
    (() => {
      const panel = document.querySelector('[data-name="bottom-widgetbar"]') || document.querySelector('[class*="bottomPanel"]');
      if (!panel) return [];
      return Array.from(panel.querySelectorAll('*'))
        .map(el => el.textContent.trim())
        .filter(t => /^\$?[\d,]+\.?\d*$/.test(t))
        .slice(0, 10);
    })()
  `);
  for (const text of [...(panelTexts || []), ...(numericPanelTexts || [])]) {
    const num = parseFloat(text.replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(num)) return num;
  }
  return 50000; // Default paper trading balance
}

// ── Helper: Check if paper trading is connected ───────
async function isPaperConnected() {
  try {
    const result = await evaluate(`
      (() => {
        // Check for paper trading panel presence
        const panel = document.querySelector('[data-name="bottom-widgetbar"]');
        if (!panel) return false;
        const text = panel.textContent;
        return text.includes('Paper Trading') || text.includes('Positions') || text.includes('Account balance');
      })()
    `);
    return result === true;
  } catch {
    return false;
  }
}

// ── Helper: Get current symbol ────────────────────────
async function getCurrentSymbol() {
  try {
    const symbol = await evaluate(`
      (() => {
        const chartValue = window.TradingViewApi?._activeChartWidgetWV?.value;
        if (!chartValue) return null;
        const chart = chartValue?.();
        if (!chart) return null;
        const series = chart._chartWidget?.model?.()?.mainSeries?.();
        return series ? series.symbol() : null;
      })()
    `);
    return symbol || 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

// ── Helper: Get current price ─────────────────────────
async function getCurrentPrice() {
  try {
    return await evaluate(`
      (() => {
        const chartValue = window.TradingViewApi?._activeChartWidgetWV?.value;
        if (!chartValue) return null;
        const chart = chartValue?.();
        const series = chart?._chartWidget?.model?.()?.mainSeries?.();
        if (!series) return null;
        const bars = series.bars?.();
        if (!bars) return null;
        const last = bars.lastProjectedValue || bars.valueAt?.(bars.size() - 1);
        return last ? last[4] : null;
      })()
    `);
  } catch {
    return null;
  }
}

// ── Helper: Click buy/sell button via CDP ─────────────
async function clickTradingButton(side, quantity) {
  // Find the buy/sell button on the chart
  const buttonSelector = side === 'buy'
    ? '.button-OH8c8Nc3.buyButton-OH8c8Nc3, [class*="buyButton"]'
    : '.button-OH8c8Nc3.sellButton-OH8c8Nc3, [class*="sellButton"]';

  const buttons = await evaluate(`
    (() => {
      const els = document.querySelectorAll(${JSON.stringify(buttonSelector)});
      return Array.from(els).map(el => ({
        text: el.textContent.trim(),
        rect: el.getBoundingClientRect ? {
          x: el.getBoundingClientRect().x,
          y: el.getBoundingClientRect().y,
          width: el.getBoundingClientRect().width,
          height: el.getBoundingClientRect().height,
        } : null,
      }));
    })()
  `);

  if (!buttons || buttons.length === 0) {
    throw new Error(`No ${side} button found on chart`);
  }

  const btn = buttons[0];
  if (!btn.rect) {
    throw new Error(`Cannot determine ${side} button position`);
  }

  // Click the center of the button
  const centerX = btn.rect.x + btn.rect.width / 2;
  const centerY = btn.rect.y + btn.rect.height / 2;

  await evaluate(`
    (() => {
      const el = document.elementFromPoint(${centerX}, ${centerY});
      if (el) {
        el.click();
        return 'clicked';
      }
      return 'not found';
    })()
  `);

  return { clicked: true, x: centerX, y: centerY };
}

// ── Generate unique order ID ──────────────────────────
function makeOrderId(prefix = 'order') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── In-memory order/position store (since we can't easily read TV's internal state) ──
// This is a simplification. In a production adapter, you'd read from TV's DOM.
const _orders = [];
const _positions = [];

export default {
  broker: BROKER,

  async snapshot({ expected_account }) {
    assertExpectedAccount(expected_account);
    const connected = await isPaperConnected();
    const balance = await getBalance();
    const symbol = await getCurrentSymbol();

    // Read from TradingView's paper trading DOM if possible
    // For now, use our tracked state
    const orders = [..._orders];
    const positions = [..._positions];

    return {
      observed_at: new Date().toISOString(),
      account: {
        broker: BROKER,
        account_id: ACCOUNT_ID,
        account_type: ACCOUNT_TYPE,
        connected,
        is_simulation: true,
        simulation_evidence: 'TradingView Paper Trading account via CDP',
      },
      balances: {
        USD: { available: balance, total: balance },
      },
      orders,
      positions,
    };
  },

  async submitOrder({ order }, guardContext) {
    assertExpectedAccount(guardContext?.expected_account);
    const { side, type, quantity, symbol } = order;

    if (type !== 'market') {
      throw new Error('Only market orders supported in this adapter');
    }

    const orderId = makeOrderId('paper');
    const price = await getCurrentPrice() || 0;

    // Click the trading button
    await clickTradingButton(side, quantity);

    // Track the order
    const orderEntry = {
      id: orderId,
      symbol: symbol || await getCurrentSymbol(),
      side,
      type,
      quantity,
      status: 'filled',
      filled_quantity: quantity,
      avg_fill_price: price,
      created_at: new Date().toISOString(),
    };
    _orders.push(orderEntry);

    // Update position
    const existingPos = _positions.find(p => p.symbol === orderEntry.symbol);
    if (existingPos) {
      if (side === 'buy') {
        existingPos.quantity += quantity;
      } else {
        existingPos.quantity -= quantity;
      }
      if (existingPos.quantity === 0) {
        const idx = _positions.indexOf(existingPos);
        _positions.splice(idx, 1);
      }
    } else {
      _positions.push({
        id: `pos-${orderId}`,
        symbol: orderEntry.symbol,
        quantity: side === 'buy' ? quantity : -quantity,
        avg_entry_price: price,
      });
    }

    return { order_id: orderId, status: 'filled', filled_quantity: quantity };
  },

  async cancelOrder({ order_id }, guardContext) {
    assertExpectedAccount(guardContext?.expected_account);
    const order = _orders.find(o => o.id === order_id);
    if (!order) throw new Error(`Order ${order_id} not found`);
    if (order.status === 'filled') throw new Error('Cannot cancel filled order');
    order.status = 'cancelled';
    return { order_id, status: 'cancelled' };
  },

  async replaceOrder({ order_id, replacement }, guardContext) {
    assertExpectedAccount(guardContext?.expected_account);
    throw new Error('Order replacement not supported in this adapter');
  },

  async closePosition({ position_id, quantity }, guardContext) {
    assertExpectedAccount(guardContext?.expected_account);
    const pos = _positions.find(p => p.id === position_id);
    if (!pos) throw new Error(`Position ${position_id} not found`);

    const closeQty = quantity || Math.abs(pos.quantity);
    const side = pos.quantity > 0 ? 'sell' : 'buy';

    await clickTradingButton(side, closeQty);

    pos.quantity = pos.quantity > 0 ? pos.quantity - closeQty : pos.quantity + closeQty;
    if (pos.quantity === 0) {
      const idx = _positions.indexOf(pos);
      _positions.splice(idx, 1);
    }

    return { position_id, closed_quantity: closeQty };
  },
};
