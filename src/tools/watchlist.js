import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/watchlist.js';

export function registerWatchlistTools(server) {
  server.tool('watchlist_import', 'Safely create or select a named TradingView watchlist from a TradingView-formatted text file. Validates layout, pane count, visible Paper Trading state, and absence of a live broker before changing the watchlist. Set dry_run to probe without selecting or importing.', {
    file_path: z.string().describe('Readable local TradingView watchlist text file'),
    name: z.string().describe('Exact name for the imported or selected watchlist'),
    require_paper_connected: z.boolean().optional().describe('Require Paper Trading to be visibly connected (default false)'),
    required_layout: z.string().optional().describe('Exact saved-layout name that must currently be active'),
    expected_pane_count: z.coerce.number().int().positive().optional().describe('Exact number of visible chart panes required'),
    dry_run: z.boolean().optional().describe('Validate file and UI state, including menu/upload control, without choosing a file or changing watchlists'),
  }, async (args) => {
    try {
      const result = await core.importWatchlist(args);
      return jsonResult(result, !result.success);
    } catch (err) {
      return jsonResult({ success: false, error: { stage: 'unexpected', message: err.message } }, true);
    }
  });

  server.tool('watchlist_get', 'Get all symbols from the current TradingView watchlist with last price, change, and change%', {}, async () => {
    try { return jsonResult(await core.get()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_add', 'Add a symbol to the TradingView watchlist', {
    symbol: z.string().describe('Symbol to add (e.g., AAPL, BTCUSD, ES1!, NYMEX:CL1!)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.add({ symbol })); }
    catch (err) {
      // Try to close any open search/input on error
      try {
        const { getClient } = await import('../connection.js');
        const c = await getClient();
        await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch (_) {}
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('watchlist_add_bulk', 'Add multiple symbols to the TradingView watchlist', {
    symbols: z.array(z.string()).describe('Symbols to add (e.g., ["AAPL", "ES1!", "NYMEX:CL1!"])'),
  }, async ({ symbols }) => {
    try { return jsonResult(await core.addBulk({ symbols })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('watchlist_remove', 'Remove one or more symbols from the active TradingView watchlist', {
    symbols: z.array(z.string()).describe('Symbols to remove — bare (AAPL) or full (NASDAQ:AAPL)'),
  }, async ({ symbols }) => {
    try { return jsonResult(await core.remove({ symbols })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
