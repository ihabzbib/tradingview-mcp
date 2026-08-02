/** Focused unit tests for supervised Paper Trading watchlist import. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureImportMenuOpen,
  findMenuItem,
  importWatchlist,
  isUploadLabel,
  parseTradingViewWatchlist,
} from '../src/core/watchlist-import.js';
import { registerWatchlistTools } from '../src/tools/watchlist.js';

const TARGET = '8/2/26 - DT';
const FILE_INFO = {
  file_path: '/tmp/morning-watchlist.txt',
  file_name: 'morning-watchlist.txt',
  sections: ['SECONDARY', 'CONTEXT'],
  symbols: ['NASDAQ:AMZN', 'AMEX:SPY'],
  invalid_tokens: [],
};

function baseState(overrides = {}) {
  return {
    active_watchlist: 'Unrelated List',
    active_watchlist_id: 'old-id',
    layout: 'Supervised Morning 6-Pane',
    pane_count: 6,
    paper_connected: true,
    live_broker_active: false,
    sections: ['SECONDARY', 'CONTEXT'],
    symbols: ['NASDAQ:MSFT'],
    ...overrides,
  };
}

function item(label, extra = {}) {
  return { label, x: 10, y: 20, role: 'menuitem', ...extra };
}

function makeDriver({
  state = baseState(),
  menuItems = [item('Upload list…')],
  menuAlreadyOpen = false,
  uploadResults = [{ chooser_opened: true, file_assigned: true }],
  importedState = baseState({
    active_watchlist: 'morning-watchlist',
    active_watchlist_id: 'new-id',
    symbols: FILE_INFO.symbols,
  }),
  selectedState,
  renameState,
} = {}) {
  let currentState = structuredClone(state);
  const calls = {
    prepare: 0, inspect: 0, openMenu: 0, closeMenu: 0, menuClicks: [],
    upload: 0, rename: 0, intercept: [], capture: 0, sequence: [], existingChecks: 0,
  };
  return {
    calls,
    get state() { return currentState; },
    driver: {
      async prepare() { calls.prepare++; calls.sequence.push('prepare'); },
      async inspectState() { calls.inspect++; return structuredClone(currentState); },
      async setChooserInterception(enabled) {
        calls.intercept.push(enabled);
        calls.sequence.push(enabled ? 'intercept-on' : 'intercept-off');
      },
      async openMenu() {
        calls.openMenu++;
        calls.sequence.push('open-menu');
        return {
          open: true,
          was_already_open: menuAlreadyOpen,
          labels: menuItems.map(entry => entry.label),
          items: menuItems,
        };
      },
      async closeMenu() { calls.closeMenu++; },
      async clickMenuItem(entry) {
        calls.menuClicks.push(entry.label);
        if (selectedState) currentState = structuredClone(selectedState);
      },
      async selectExisting(name, menu) {
        calls.existingChecks++;
        if (selectedState) {
          calls.menuClicks.push(name);
          currentState = structuredClone(selectedState);
          return { selected: true, menu, source: menuItems.some(entry => entry.label === name) ? 'watchlist_menu' : 'watchlists_dialog' };
        }
        return { selected: false, menu, source: 'watchlists_dialog' };
      },
      async uploadFile() {
        const result = uploadResults[Math.min(calls.upload, uploadResults.length - 1)];
        calls.upload++;
        if (result?.file_assigned) currentState = structuredClone(importedState);
        return result;
      },
      async renameActive(name) {
        calls.rename++;
        currentState = renameState
          ? structuredClone(renameState)
          : { ...currentState, active_watchlist: name };
      },
      async captureFailure(stage) { calls.capture++; return `/tmp/${stage}.png`; },
      async wait() {},
    },
  };
}

function runImport(mock, overrides = {}) {
  return importWatchlist({
    file_path: FILE_INFO.file_path,
    name: TARGET,
    require_paper_connected: true,
    required_layout: 'Supervised Morning 6-Pane',
    expected_pane_count: 6,
    _deps: {
      validateImportFile: async () => structuredClone(FILE_INFO),
      driver: mock.driver,
    },
    ...overrides,
  });
}

describe('TradingView watchlist file validation', () => {
  it('parses comma/newline sections and exchange-qualified symbols', () => {
    const parsed = parseTradingViewWatchlist(`
      ###SECONDARY,NASDAQ:AMZN\nNASDAQ:DXCM,NYSE:VRT
      ###CONTEXT\nAMEX:SPY,NASDAQ:QQQ
    `);
    assert.deepEqual(parsed.sections, ['SECONDARY', 'CONTEXT']);
    assert.deepEqual(parsed.symbols, ['NASDAQ:AMZN', 'NASDAQ:DXCM', 'NYSE:VRT', 'AMEX:SPY', 'NASDAQ:QQQ']);
    assert.deepEqual(parsed.invalid_tokens, []);
  });

  it('rejects an invalid import file before connecting to TradingView', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tv-watchlist-test-'));
    const file = join(dir, 'invalid.txt');
    await writeFile(file, '###SECONDARY\nAAPL\n###CONTEXT\nSPY\n');
    const mock = makeDriver();
    try {
      const result = await importWatchlist({ file_path: file, name: TARGET, _deps: { driver: mock.driver } });
      assert.equal(result.success, false);
      assert.equal(result.stage, 'file_validation');
      assert.equal(result.state_changed, false);
      assert.equal(mock.calls.prepare, 0, 'no TradingView access before file validation');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('menu reliability helpers', () => {
  it('does not click when the menu is already open', async () => {
    let clicks = 0;
    const menu = await ensureImportMenuOpen({
      inspect: async () => ({ open: true, labels: ['Upload list…'], items: [item('Upload list…')] }),
      click: async () => { clicks++; },
    });
    assert.equal(clicks, 0);
    assert.equal(menu.was_already_open, true);
  });

  for (const label of ['Upload list…', 'Upload list...', 'Upload list', 'Import list']) {
    it(`recognizes upload label variant: ${label}`, () => {
      assert.equal(isUploadLabel(label), true);
    });
  }

  it('returns the nearest actionable item represented around nested text', () => {
    const actionable = item('Watchlist action', { tag: 'button', nested_text: 'Upload list…' });
    const found = findMenuItem({ items: [actionable] }, isUploadLabel);
    assert.equal(found, actionable);
    assert.equal(found.tag, 'button');
  });
});

describe('watchlist import orchestration', () => {
  it('selects and verifies an existing target list without uploading', async () => {
    const selected = baseState({
      active_watchlist: TARGET,
      active_watchlist_id: 'target-id',
      symbols: FILE_INFO.symbols,
    });
    const mock = makeDriver({
      menuItems: [item(TARGET), item('Upload list…')],
      selectedState: selected,
    });
    const result = await runImport(mock);
    assert.equal(result.success, true);
    assert.equal(result.action, 'selected');
    assert.equal(result.watchlist, TARGET);
    assert.equal(mock.calls.upload, 0);
    assert.equal(mock.calls.rename, 0);
    assert.deepEqual(mock.calls.menuClicks, [TARGET]);
  });

  it('selects a non-recent existing list through the full Watchlists dialog', async () => {
    const selected = baseState({
      active_watchlist: TARGET,
      active_watchlist_id: 'older-target-id',
      symbols: FILE_INFO.symbols,
    });
    const mock = makeDriver({
      menuItems: [item('Upload list…'), item('Open list…')],
      selectedState: selected,
    });
    const result = await runImport(mock);
    assert.equal(result.success, true);
    assert.equal(result.action, 'selected');
    assert.equal(mock.calls.existingChecks, 1);
    assert.equal(mock.calls.upload, 0, 'existing non-recent list is never duplicated');
    assert.equal(mock.calls.rename, 0);
  });

  it('returns already_current when the exact target is already active', async () => {
    const mock = makeDriver({ state: baseState({ active_watchlist: TARGET, active_watchlist_id: 'target-id' }) });
    const result = await runImport(mock);
    assert.equal(result.success, true);
    assert.equal(result.action, 'already_current');
    assert.equal(result.state_changed, false);
    assert.equal(mock.calls.upload, 0);
  });

  it('imports a new list, renames only that list, and returns verified contents', async () => {
    const mock = makeDriver();
    const result = await runImport(mock);
    assert.equal(result.success, true);
    assert.equal(result.action, 'created');
    assert.equal(result.watchlist, TARGET);
    assert.deepEqual(result.sections, ['SECONDARY', 'CONTEXT']);
    assert.deepEqual(result.symbols, FILE_INFO.symbols);
    assert.equal(mock.calls.upload, 1);
    assert.equal(mock.calls.rename, 1);
    assert.deepEqual(mock.calls.intercept, [true, false]);
    assert.ok(
      mock.calls.sequence.indexOf('intercept-on') < mock.calls.sequence.indexOf('open-menu'),
      'chooser interception enabled before opening the menu',
    );
  });

  it('supports a menu that was already open', async () => {
    const mock = makeDriver({ menuAlreadyOpen: true });
    const result = await runImport(mock);
    assert.equal(result.success, true);
    assert.equal(mock.calls.openMenu, 1, 'workflow inspects the already-open menu once');
  });

  it('retries once when the chooser does not open, then succeeds', async () => {
    const mock = makeDriver({
      uploadResults: [
        { chooser_opened: false, file_assigned: false },
        { chooser_opened: true, file_assigned: true },
      ],
    });
    const result = await runImport(mock);
    assert.equal(result.success, true);
    assert.equal(result.retry_count, 1);
    assert.equal(mock.calls.upload, 2);
    assert.ok(mock.calls.closeMenu >= 1, 'Escape/close used before retry');
    assert.equal(mock.calls.rename, 1, 'new list renamed once');
  });

  it('returns structured diagnostics when the chooser never opens', async () => {
    const mock = makeDriver({ uploadResults: [{ chooser_opened: false, file_assigned: false }] });
    const result = await runImport(mock);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'file_chooser');
    assert.equal(result.retry_count, 1);
    assert.equal(result.state_changed, false);
    assert.equal(result.active_watchlist_before, 'Unrelated List');
    assert.equal(result.active_watchlist_after, 'Unrelated List');
    assert.deepEqual(result.visible_menu_item_labels, ['Upload list…']);
    assert.equal(result.screenshot_path, '/tmp/file_chooser.png');
    assert.equal(mock.calls.upload, 2);
    assert.equal(mock.calls.rename, 0);
  });

  it('fails before opening the menu when the required layout is missing', async () => {
    const mock = makeDriver({ state: baseState({ layout: 'Different Layout' }) });
    const result = await runImport(mock);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'layout_validation');
    assert.equal(mock.calls.openMenu, 0);
    assert.equal(mock.calls.upload, 0);
  });

  it('fails before opening the menu when pane count is wrong', async () => {
    const mock = makeDriver({ state: baseState({ pane_count: 4 }) });
    const result = await runImport(mock);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'pane_validation');
    assert.equal(mock.calls.openMenu, 0);
  });

  it('fails before opening the menu when Paper Trading is disconnected', async () => {
    const mock = makeDriver({ state: baseState({ paper_connected: false }) });
    const result = await runImport(mock);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'paper_connection_validation');
    assert.equal(mock.calls.openMenu, 0);
  });

  it('blocks when a live broker is visibly active', async () => {
    const mock = makeDriver({ state: baseState({ paper_connected: false, live_broker_active: true }) });
    const result = await runImport(mock, { require_paper_connected: false });
    assert.equal(result.success, false);
    assert.equal(result.stage, 'live_broker_validation');
    assert.equal(mock.calls.openMenu, 0);
  });

  it('never retries after a file was assigned, preventing duplicate lists', async () => {
    const mock = makeDriver({ importedState: baseState() });
    const result = await runImport(mock);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'post_import_detection');
    assert.equal(result.state_changed, true);
    assert.equal(mock.calls.upload, 1, 'upload is never repeated after file assignment');
    assert.equal(mock.calls.rename, 0, 'unverified list is never renamed');
  });

  it('does not retry when the chooser opened but assignment was not confirmed', async () => {
    const mock = makeDriver({ uploadResults: [{ chooser_opened: true, file_assigned: false }] });
    const result = await runImport(mock);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'file_assignment');
    assert.equal(mock.calls.upload, 1);
    assert.equal(mock.calls.rename, 0);
  });

  it('reports post-import verification failure without duplicate upload', async () => {
    const mock = makeDriver({
      renameState: baseState({
        active_watchlist: TARGET,
        active_watchlist_id: 'new-id',
        sections: ['SECONDARY'],
        symbols: FILE_INFO.symbols,
      }),
    });
    const result = await runImport(mock);
    assert.equal(result.success, false);
    assert.equal(result.stage, 'post_import_verification');
    assert.match(result.error.message, /CONTEXT/);
    assert.equal(mock.calls.upload, 1);
    assert.equal(mock.calls.rename, 1);
  });

  it('dry-run probes the upload control without selecting or assigning a file', async () => {
    const mock = makeDriver();
    const result = await runImport(mock, { dry_run: true });
    assert.equal(result.success, true);
    assert.equal(result.action, 'dry_run');
    assert.equal(result.state_changed, false);
    assert.equal(result.upload_control, 'Upload list…');
    assert.equal(mock.calls.upload, 0);
    assert.equal(mock.calls.rename, 0);
    assert.deepEqual(mock.calls.menuClicks, []);
  });
});

describe('financial-scope isolation', () => {
  it('does not import or reference order and alert modules', async () => {
    const paths = [
      '../src/core/watchlist-import.js',
      '../src/core/watchlist.js',
      '../src/tools/watchlist.js',
      '../src/cli/commands/watchlist.js',
    ];
    const source = (await Promise.all(paths.map(path => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:alerts?|orders?)[^'"]*['"]/i);
    assert.doesNotMatch(source, /(?:create|cancel|place|submit)(?:Order|Alert)/);
  });
});

describe('MCP interface', () => {
  it('registers watchlist_import with the guarded structured arguments', () => {
    const registered = new Map();
    const server = {
      tool(name, description, schema, handler) { registered.set(name, { description, schema, handler }); },
    };
    registerWatchlistTools(server);
    const tool = registered.get('watchlist_import');
    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.schema), [
      'file_path', 'name', 'require_paper_connected', 'required_layout', 'expected_pane_count', 'dry_run',
    ]);
    assert.match(tool.description, /Safely create or select/);
  });
});
