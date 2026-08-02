import { register } from '../router.js';
import * as core from '../../core/watchlist.js';

register('watchlist', {
  description: 'Watchlist tools (get, add, add-bulk, remove, import)',
  subcommands: new Map([
    ['import', {
      description: 'Safely create/select a named watchlist from a TradingView text file',
      options: {
        file: { type: 'string', short: 'f', description: 'TradingView watchlist text file (required)' },
        name: { type: 'string', short: 'n', description: 'Exact target watchlist name (required)' },
        'require-paper-connected': { type: 'boolean', description: 'Require visibly connected Paper Trading' },
        'required-layout': { type: 'string', description: 'Exact active saved-layout name required' },
        'expected-pane-count': { type: 'string', description: 'Exact active pane count required' },
        'dry-run': { type: 'boolean', description: 'Probe file/layout/trading/menu state without changing watchlists' },
      },
      handler: (opts) => {
        if (!opts.file) throw new Error('File required. Usage: tv watchlist import --file <path> --name "My List"');
        if (!opts.name) throw new Error('Name required. Usage: tv watchlist import --file <path> --name "My List"');
        return core.importWatchlist({
          file_path: opts.file,
          name: opts.name,
          require_paper_connected: !!opts['require-paper-connected'],
          required_layout: opts['required-layout'],
          expected_pane_count: opts['expected-pane-count'] === undefined ? undefined : Number(opts['expected-pane-count']),
          dry_run: !!opts['dry-run'],
        });
      },
    }],
    ['get', {
      description: 'Get watchlist symbols',
      handler: () => core.get(),
    }],
    ['add', {
      description: 'Add a symbol to the watchlist',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv watchlist add AAPL');
        return core.add({ symbol: positionals[0] });
      },
    }],
    ['add-bulk', {
      description: 'Add multiple symbols to the watchlist',
      handler: (opts, positionals) => {
        if (!positionals.length) throw new Error('Symbols required. Usage: tv watchlist add-bulk AAPL MSFT');
        return core.addBulk({ symbols: positionals });
      },
    }],
    ['remove', {
      description: 'Remove one or more symbols from the watchlist',
      handler: (opts, positionals) => {
        if (!positionals.length) throw new Error('Symbols required. Usage: tv watchlist remove AAPL MSFT');
        return core.remove({ symbols: positionals });
      },
    }],
  ]),
});
