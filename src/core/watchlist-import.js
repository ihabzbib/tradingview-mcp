/**
 * Safe TradingView watchlist import orchestration.
 *
 * This module intentionally knows nothing about orders, alerts, or execution.
 * It only inspects visible chart/watchlist/trading-panel state and drives the
 * watchlist menu through trusted CDP input events.
 */
import { access, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, resolve } from 'node:path';
import { evaluate as defaultEvaluate, getClient as defaultGetClient } from '../connection.js';
import { captureScreenshot as defaultCaptureScreenshot } from './capture.js';

const REQUIRED_SECTIONS = ['SECONDARY', 'CONTEXT'];
const UPLOAD_LABEL_RE = /^(?:upload\s+list(?:\s*(?:…|\.\.\.))?|import\s+list)$/i;
const RENAME_LABEL_RE = /^(?:rename|rename\s+(?:list|watchlist)|edit\s+list\s+name)$/i;
const ACTIONABLE_SELECTOR = 'button, a, [role="row"], [role="menuitem"], [role="option"], [role="button"], [data-name$="-menu-item"], [data-name*="watchlist-item"]';

class ImportFailure extends Error {
  constructor(stage, message, details = {}) {
    super(message);
    this.name = 'WatchlistImportFailure';
    this.stage = stage;
    Object.assign(this, details);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalizeLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function isUploadLabel(label) {
  return UPLOAD_LABEL_RE.test(normalizeLabel(label));
}

export function findMenuItem(menu, predicate) {
  return (menu?.items || []).find(item => (
    predicate(normalizeLabel(item.label)) || predicate(normalizeLabel(item.nested_text))
  )) || null;
}

/** Parse the comma/newline-delimited format emitted and accepted by TradingView. */
export function parseTradingViewWatchlist(text) {
  const tokens = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/[\r\n,]+/)
    .map(normalizeLabel)
    .filter(Boolean);

  const sections = [];
  const symbols = [];
  const invalid_tokens = [];
  for (const token of tokens) {
    if (/^###/.test(token)) {
      const section = normalizeLabel(token.replace(/^###+/, '')).toUpperCase();
      if (section && !sections.includes(section)) sections.push(section);
      continue;
    }
    // TradingView symbols may contain digits, dots, dashes, underscores, and
    // continuous-futures exclamation marks, but imports for this workflow must
    // always include an explicit exchange prefix.
    if (/^[A-Z0-9._-]+:[A-Z0-9._!\-/]+$/i.test(token)) symbols.push(token.toUpperCase());
    else invalid_tokens.push(token);
  }

  return { sections, symbols, invalid_tokens };
}

export async function validateImportFile(filePath, deps = {}) {
  if (!filePath || !String(filePath).trim()) {
    throw new ImportFailure('file_validation', 'file_path is required');
  }
  const absolutePath = resolve(String(filePath));
  const fsAccess = deps.access || access;
  const fsStat = deps.stat || stat;
  const fsReadFile = deps.readFile || readFile;

  try {
    await fsAccess(absolutePath, fsConstants.R_OK);
    const info = await fsStat(absolutePath);
    if (!info.isFile()) throw new Error('path is not a regular file');
  } catch (err) {
    throw new ImportFailure('file_validation', `Import file is not readable: ${absolutePath} (${err.message})`);
  }

  let text;
  try {
    text = await fsReadFile(absolutePath, 'utf8');
  } catch (err) {
    throw new ImportFailure('file_validation', `Could not read import file: ${absolutePath} (${err.message})`);
  }
  const parsed = parseTradingViewWatchlist(text);
  if (!parsed.symbols.length) {
    throw new ImportFailure('file_validation', 'Import file contains no exchange-qualified symbols (expected EXCHANGE:SYMBOL)');
  }
  if (parsed.invalid_tokens.length) {
    throw new ImportFailure(
      'file_validation',
      `Import file contains non-exchange-qualified or invalid entries: ${parsed.invalid_tokens.slice(0, 8).join(', ')}`,
      { invalid_tokens: parsed.invalid_tokens },
    );
  }
  const missing = REQUIRED_SECTIONS.filter(section => !parsed.sections.includes(section));
  if (missing.length) {
    throw new ImportFailure('file_validation', `Import file is missing required section(s): ${missing.join(', ')}`);
  }

  return { file_path: absolutePath, file_name: basename(absolutePath), ...parsed };
}

async function trustedClick(client, target) {
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new Error('Actionable element has no usable screen coordinates');
  }
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: target.x, y: target.y });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function pressKey(client, key, code, windowsVirtualKeyCode, modifiers = 0) {
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
}

async function inspectMenu(evaluate) {
  return evaluate(`
    (function() {
      function visible(el) {
        if (!el) return false;
        var rect = el.getBoundingClientRect();
        var style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }
      function point(el) {
        var rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
          width: rect.width, height: rect.height, tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'), data_name: el.getAttribute('data-name'),
          aria_label: el.getAttribute('aria-label') };
      }
      function text(el) { return (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim(); }

      var panel = document.querySelector('[class*="layout__area--right"]') || document;
      var openerSelectors = [
        '[data-name="watchlists-button"]', '[data-name="watchlist-menu"]', '[data-name="watchlist-title"] button',
        '[data-name="watchlist-title"]', '[aria-label="Watchlist menu"]',
        '[aria-label="Manage watchlist"]', '[aria-haspopup="menu"][data-name*="watchlist"]'
      ];
      var opener = null;
      for (var s = 0; s < openerSelectors.length && !opener; s++) {
        var candidate = panel.querySelector(openerSelectors[s]);
        if (visible(candidate)) opener = candidate.closest('${ACTIONABLE_SELECTOR}') || candidate;
      }

      var roots = document.querySelectorAll('[class*="watchlistMenu"], [role="menu"], [data-name*="watchlist-menu"], [data-name="popup-menu-container"], [class*="menuWrap"]');
      var root = null;
      for (var r = roots.length - 1; r >= 0; r--) {
        if (!visible(roots[r])) continue;
        var rootText = text(roots[r]);
        if (/upload\\s+list|import\\s+list|rename\\s+(?:list|watchlist)/i.test(rootText)
          || roots[r].querySelector('[role="menuitem"], [role="option"]')) { root = roots[r]; break; }
      }

      var items = [];
      var seen = [];
      if (root) {
        var nested = root.querySelectorAll('span, div, button, a, [role="menuitem"], [role="option"], [role="button"], [data-name]');
        for (var i = 0; i < nested.length; i++) {
          if (!visible(nested[i])) continue;
          var label = text(nested[i]);
          if (!label || label.length > 180) continue;
          var action = nested[i].closest('${ACTIONABLE_SELECTOR}');
          if (!action || !root.contains(action) || !visible(action)) continue;
          if (seen.indexOf(action) !== -1) continue;
          seen.push(action);
          items.push(Object.assign({ label: text(action), nested_text: label }, point(action)));
        }
      }
      return {
        open: !!root,
        opener: opener ? point(opener) : null,
        labels: items.map(function(item) { return item.label; }),
        items: items
      };
    })()
  `);
}

/** Ensure a watchlist menu is open without toggling an already-open menu closed. */
export async function ensureImportMenuOpen({ inspect, click, wait = sleep, maxWaitMs = 4000 }) {
  let menu = await inspect();
  if (menu?.open) return { ...menu, was_already_open: true };
  if (!menu?.opener) throw new Error('Watchlist menu opener not found');
  await click(menu.opener);

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await wait(100);
    menu = await inspect();
    if (menu?.open) return { ...menu, was_already_open: false };
  }
  throw new Error('Watchlist menu did not become ready');
}

async function inspectState(evaluate) {
  return evaluate(`
    (function() {
      function visible(el) {
        if (!el) return false;
        var rect = el.getBoundingClientRect();
        var style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }
      function clean(value) { return String(value || '').replace(/\\s+/g, ' ').trim(); }
      function readValue(value) { return value && typeof value.value === 'function' ? value.value() : value; }

      var panel = document.querySelector('[class*="layout__area--right"]');
      var rows = panel ? panel.querySelectorAll('[data-symbol-full]') : [];
      var symbols = [], seenSymbols = {};
      for (var i = 0; i < rows.length; i++) {
        var symbol = rows[i].getAttribute('data-symbol-full');
        if (symbol && !seenSymbols[symbol]) { seenSymbols[symbol] = true; symbols.push(symbol); }
      }

      var active = { id: null, name: null, symbols: null };
      if (rows.length) {
        var reactKey = Object.keys(rows[0]).find(function(key) { return key.indexOf('__reactFiber') === 0; });
        var fiber = reactKey ? rows[0][reactKey] : null;
        for (var depth = 0; fiber && depth < 50; depth++, fiber = fiber.return) {
          var current = fiber.memoizedProps && fiber.memoizedProps.current;
          if (current && current.id && current.name) {
            active = { id: String(current.id), name: clean(current.name), symbols: Array.isArray(current.symbols) ? current.symbols : null };
            break;
          }
        }
      }
      if (!active.name && panel) {
        var titleSelectors = ['[data-name="watchlist-title"]', '[data-name="watchlist-name"]', '[aria-label^="Current watchlist"]'];
        for (var t = 0; t < titleSelectors.length && !active.name; t++) {
          var title = panel.querySelector(titleSelectors[t]);
          if (visible(title)) active.name = clean(title.getAttribute('aria-label') || title.textContent).replace(/^Current watchlist:\\s*/i, '');
        }
      }

      var sections = [], seenSections = {};
      if (panel) {
        var sectionCandidates = panel.querySelectorAll('[data-name="tree"] [class*="separator"] [class*="label"], [data-name*="section"], [role="separator"], [class*="sectionTitle"], [class*="sectionHeader"]');
        for (var j = 0; j < sectionCandidates.length; j++) {
          if (!visible(sectionCandidates[j])) continue;
          var section = clean(sectionCandidates[j].textContent).toUpperCase();
          if (section && section.length < 80 && !seenSections[section]) { seenSections[section] = true; sections.push(section); }
        }
      }

      var cwc = window.TradingViewApi && window.TradingViewApi._chartWidgetCollection;
      var paneCount = null;
      if (cwc) {
        try { paneCount = Number(readValue(cwc.inlineChartsCount)); } catch (_) {}
        if (!Number.isFinite(paneCount)) { try { paneCount = cwc.getAll().length; } catch (_) {} }
      }

      var layout = null;
      var activeLayoutElement = document.querySelector('[aria-label*="Active layout:"]');
      if (activeLayoutElement) {
        var activeLayoutMatch = clean(activeLayoutElement.getAttribute('aria-label')).match(/Active layout:\\s*(.+)$/i);
        if (activeLayoutMatch) layout = clean(activeLayoutMatch[1]);
      }
      var saveLayoutButtons = document.querySelectorAll('button[aria-label^="Save all charts for all symbols and intervals on your layout"]');
      for (var sb = 0; sb < saveLayoutButtons.length && !layout; sb++) {
        if (!visible(saveLayoutButtons[sb])) continue;
        var layoutText = saveLayoutButtons[sb].querySelector('span[class*="text"]');
        if (layoutText) layout = clean(layoutText.textContent);
      }
      var layoutSelectors = [
        '[data-name="save-load-menu"]', '[data-name="header-toolbar-save-load"]',
        '[data-name="layout-title"]', '[aria-label^="Current layout"]'
      ];
      for (var l = 0; l < layoutSelectors.length && !layout; l++) {
        var layoutEl = document.querySelector(layoutSelectors[l]);
        if (visible(layoutEl)) {
          var aria = clean(layoutEl.getAttribute('aria-label'));
          var candidateLayout = /^Current layout:/i.test(aria)
            ? aria.replace(/^Current layout:\\s*/i, '')
            : clean(layoutEl.getAttribute('data-layout-name') || layoutEl.getAttribute('title') || layoutEl.textContent);
          candidateLayout = candidateLayout.replace(/\\s+(?:Save|Saved)$/i, '');
          if (candidateLayout && !/^(?:manage layouts|save|saved)$/i.test(candidateLayout)) layout = candidateLayout;
        }
      }
      if (!layout && cwc) {
        var layoutProps = ['_layoutName', 'layoutName', '_chartName', 'chartName'];
        for (var lp = 0; lp < layoutProps.length && !layout; lp++) {
          try { layout = clean(readValue(cwc[layoutProps[lp]])); } catch (_) {}
        }
      }

      var statusSelectors = [
        '[data-name*="broker"]', '[data-name*="trading"]', '[class*="broker"]',
        '[aria-label*="broker" i]', '[aria-label*="Paper Trading" i]', '[role="status"]'
      ];
      var statusElements = document.querySelectorAll(statusSelectors.join(','));
      var brokerLabels = [];
      for (var b = 0; b < statusElements.length; b++) {
        if (!visible(statusElements[b])) continue;
        var statusText = clean(statusElements[b].getAttribute('aria-label') || statusElements[b].textContent);
        if (statusText && statusText.length < 240 && brokerLabels.indexOf(statusText) === -1) brokerLabels.push(statusText);
      }
      var joined = brokerLabels.join(' | ');
      var paperVisible = /paper trading/i.test(joined);
      var connectedSignal = /(?:connected|disconnect|account|positions|orders|equity|balance)/i.test(joined)
        || !!document.querySelector('[data-name*="broker"][data-connected="true"], [aria-label*="Disconnect" i]');
      var disconnectedSignal = /disconnected|connect\\s+(?:paper|broker|account)/i.test(joined);
      var paperConnected = paperVisible && connectedSignal && !disconnectedSignal;
      var liveBrokerActive = !paperVisible && connectedSignal && /broker|trading|account|positions|orders/i.test(joined);

      return {
        active_watchlist: active.name || null,
        active_watchlist_id: active.id || null,
        sections: sections,
        symbols: Array.isArray(active.symbols)
          ? active.symbols.filter(function(symbol) { return typeof symbol === 'string' && symbol.indexOf(':') > 0; })
          : [],
        symbols_source: Array.isArray(active.symbols) ? 'react_fiber' : 'unavailable',
        layout: layout || null,
        pane_count: Number.isFinite(paneCount) ? paneCount : null,
        paper_connected: !!paperConnected,
        live_broker_active: !!liveBrokerActive,
        broker_labels: brokerLabels
      };
    })()
  `);
}

function addClientListener(client, eventName, handler) {
  if (typeof client.on === 'function') {
    client.on(eventName, handler);
    return () => {
      if (typeof client.removeListener === 'function') client.removeListener(eventName, handler);
      else if (typeof client.off === 'function') client.off(eventName, handler);
    };
  }
  const [domain, event] = eventName.split('.');
  if (typeof client?.[domain]?.[event] === 'function') {
    client[domain][event](handler);
    return () => client[domain][event].removeListener?.(handler);
  }
  throw new Error(`CDP client cannot subscribe to ${eventName}`);
}

function createLiveDriver(overrides = {}) {
  const evaluate = overrides.evaluate || defaultEvaluate;
  const getClient = overrides.getClient || defaultGetClient;
  const wait = overrides.sleep || sleep;
  const captureScreenshot = overrides.captureScreenshot || defaultCaptureScreenshot;
  let client;

  async function getCdpClient() {
    if (!client) client = await getClient();
    return client;
  }

  async function closeMenu() {
    const c = await getCdpClient();
    await pressKey(c, 'Escape', 'Escape', 27);
    await wait(100);
  }

  async function openMenu() {
    const c = await getCdpClient();
    return ensureImportMenuOpen({
      inspect: () => inspectMenu(evaluate),
      click: target => trustedClick(c, target),
      wait,
    });
  }

  async function clickMenuItem(item) {
    const c = await getCdpClient();
    await trustedClick(c, item);
  }

  async function selectExisting(name, initialMenu) {
    const c = await getCdpClient();
    const direct = findMenuItem(initialMenu, label => label === name);
    if (direct) {
      await trustedClick(c, direct);
      return { selected: true, menu: initialMenu, source: 'watchlist_menu' };
    }

    const openList = findMenuItem(initialMenu, label => /^open\s+list(?:\s*(?:…|\.\.\.))?(?:\s|$)/i.test(label));
    if (!openList) {
      throw new Error('Open list action not found; cannot safely rule out an existing watchlist');
    }
    await trustedClick(c, openList);

    let search = null;
    for (let i = 0; i < 30; i++) {
      search = await evaluate(`
        (function() {
          var dialog = document.querySelector('[data-name="watchlists-dialog"]') || document.querySelector('[role="dialog"]');
          var input = dialog && dialog.querySelector('input[role="searchbox"], input[placeholder*="Search lists" i]');
          if (!input) return null;
          var r = input.getBoundingClientRect();
          return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        })()
      `);
      if (search) break;
      await wait(100);
    }
    if (!search) throw new Error('Watchlists dialog did not become ready; existing-list check is incomplete');

    await trustedClick(c, search);
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await c.Input.insertText({ text: name });

    let exact = null;
    for (let i = 0; i < 30; i++) {
      exact = await evaluate(`
        (function() {
          function clean(value) { return String(value || '').replace(/\\s+/g, ' ').trim(); }
          var target = ${JSON.stringify(name)};
          var dialog = document.querySelector('[data-name="watchlists-dialog"]') || document.querySelector('[role="dialog"]');
          if (!dialog) return null;
          var all = dialog.querySelectorAll('div, span, button, a, [role="option"], [role="row"]');
          for (var i = 0; i < all.length; i++) {
            if (clean(all[i].textContent) !== target) continue;
            var action = all[i].closest('button, a, [role="option"], [role="row"]') || all[i].parentElement;
            if (!action || !dialog.contains(action)) continue;
            var r = action.getBoundingClientRect();
            if (r.width > 100 && r.height > 0 && r.height <= 64) {
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
          }
          return null;
        })()
      `);
      if (exact) break;
      await wait(100);
    }
    if (exact) {
      await trustedClick(c, exact);
      return { selected: true, menu: initialMenu, source: 'watchlists_dialog' };
    }

    // The exact list does not exist. Close the picker and return a freshly
    // inspected main menu so later upload coordinates cannot be stale.
    await closeMenu();
    const menu = await openMenu();
    return { selected: false, menu, source: 'watchlists_dialog' };
  }

  async function uploadFile(filePath, uploadItem, timeoutMs = 3000) {
    const c = await getCdpClient();
    let removeListener = () => {};
    let timer;
    const chooser = new Promise((resolveChooser) => {
      removeListener = addClientListener(c, 'Page.fileChooserOpened', resolveChooser);
      timer = setTimeout(() => resolveChooser(null), timeoutMs);
    });
    try {
      await trustedClick(c, uploadItem);
      const event = await chooser;
      if (!event) return { chooser_opened: false, file_assigned: false };
      if (!event.backendNodeId) throw new Error('File chooser opened without a backendNodeId');
      try {
        await c.DOM.setFileInputFiles({ files: [filePath], backendNodeId: event.backendNodeId });
      } catch (err) {
        err.chooser_opened = true;
        throw err;
      }
      return { chooser_opened: true, file_assigned: true };
    } finally {
      clearTimeout(timer);
      removeListener();
    }
  }

  async function renameActive(name) {
    const c = await getCdpClient();
    const menu = await openMenu();
    const renameItem = findMenuItem(menu, label => RENAME_LABEL_RE.test(label));
    if (!renameItem) throw new Error('Rename list action not found in watchlist menu');
    await trustedClick(c, renameItem);

    let input = null;
    for (let i = 0; i < 30; i++) {
      input = await evaluate(`
        (function() {
          var selectors = ['[role="dialog"] input', 'input[data-name*="rename"]', 'input[aria-label*="watchlist" i]'];
          for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (!el) continue;
            var r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
          return null;
        })()
      `);
      if (input) break;
      await wait(100);
    }
    if (!input) throw new Error('Rename watchlist dialog did not become ready');
    await trustedClick(c, input);
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await c.Input.insertText({ text: name });
    await pressKey(c, 'Enter', 'Enter', 13);
  }

  return {
    async prepare() {
      // Reuse the existing panel-opening path, but avoid importing any other
      // feature module. It is enough to make the lazy-loaded widget visible.
      const state = await evaluate(`
        (function() {
          var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
            || document.querySelector('[aria-label="Watchlist, details, and news"]')
            || document.querySelector('[aria-label^="Watchlist"]');
          if (!btn) return { error: 'Watchlist button not found' };
          var right = document.querySelector('[class*="layout__area--right"]');
          var open = btn.getAttribute('aria-pressed') === 'true' && right && right.getBoundingClientRect().width > 50;
          if (!open) btn.click();
          return { opened: !open };
        })()
      `);
      if (state?.error) throw new Error(state.error);
      for (let i = 0; i < 40; i++) {
        const ready = await evaluate(`!!(document.querySelector('[data-name="add-symbol-button"]') || document.querySelector('[class*="layout__area--right"] [data-symbol-full]'))`);
        if (ready) return;
        await wait(100);
      }
      throw new Error('Watchlist panel did not become ready');
    },
    inspectState: () => inspectState(evaluate),
    inspectMenu: () => inspectMenu(evaluate),
    openMenu,
    closeMenu,
    clickMenuItem,
    selectExisting,
    uploadFile,
    renameActive,
    async setChooserInterception(enabled) {
      const c = await getCdpClient();
      await c.Page.setInterceptFileChooserDialog({ enabled });
    },
    async captureFailure(stage) {
      const result = await captureScreenshot({ region: 'full', filename: `watchlist_import_${stage}_${Date.now()}` });
      return result?.file_path || null;
    },
    wait,
  };
}

function emptyFailureContext() {
  return {
    state_changed: false,
    active_watchlist_before: null,
    active_watchlist_after: null,
    visible_menu_item_labels: [],
    layout: null,
    pane_count: null,
    paper_connected: null,
    live_broker_active: null,
    retry_count: 0,
    screenshot_path: null,
  };
}

function validateOptions({ name, expectedPaneCount }) {
  if (!name || !String(name).trim()) throw new ImportFailure('input_validation', 'name is required');
  if (expectedPaneCount !== undefined && expectedPaneCount !== null) {
    const count = Number(expectedPaneCount);
    if (!Number.isInteger(count) || count < 1) {
      throw new ImportFailure('input_validation', 'expected_pane_count must be a positive integer');
    }
  }
}

function assertPreflight(state, { requiredLayout, expectedPaneCount, requirePaperConnected }) {
  if (requiredLayout && state.layout !== requiredLayout) {
    throw new ImportFailure('layout_validation', `Required layout "${requiredLayout}" is not active (active: ${state.layout || 'unknown'})`);
  }
  if (expectedPaneCount !== undefined && expectedPaneCount !== null && state.pane_count !== Number(expectedPaneCount)) {
    throw new ImportFailure('pane_validation', `Expected ${expectedPaneCount} panes, found ${state.pane_count ?? 'unknown'}`);
  }
  if (requirePaperConnected && !state.paper_connected) {
    throw new ImportFailure('paper_connection_validation', 'Paper Trading is not visibly connected');
  }
  if (state.live_broker_active) {
    throw new ImportFailure('live_broker_validation', 'A live broker appears to be active; watchlist import was blocked');
  }
}

function verifyWatchlist(state, name) {
  if (state.active_watchlist !== name) {
    throw new ImportFailure('post_import_verification', `Active watchlist is "${state.active_watchlist || 'unknown'}", expected exactly "${name}"`);
  }
  const missing = missingRequiredSections(state);
  if (missing.length) {
    throw new ImportFailure('post_import_verification', `Required watchlist section(s) not visible: ${missing.join(', ')}`);
  }
}

function missingRequiredSections(state) {
  const visibleSections = (state.sections || []).map(section => section.toUpperCase());
  return REQUIRED_SECTIONS.filter(section => (
    !visibleSections.some(visible => visible === section || visible.startsWith(`${section} `))
  ));
}

async function waitForState(driver, predicate, attempts = 40) {
  let state = null;
  for (let i = 0; i < attempts; i++) {
    state = await driver.inspectState();
    if (predicate(state)) return state;
    await driver.wait(125);
  }
  return state;
}

function isDistinctImportedList(before, after) {
  if (!after?.active_watchlist) return false;
  if (before?.active_watchlist_id && after.active_watchlist_id) {
    return before.active_watchlist_id !== after.active_watchlist_id;
  }
  return before?.active_watchlist !== after.active_watchlist;
}

function successResult(action, state, fileInfo, retryCount, extra = {}) {
  return {
    success: true,
    action,
    watchlist: state.active_watchlist,
    paper_connected: state.paper_connected,
    layout: state.layout,
    pane_count: state.pane_count,
    sections: state.sections || [],
    symbols: state.symbols || [],
    retry_count: retryCount,
    file_path: fileInfo.file_path,
    ...extra,
  };
}

/**
 * Create/select a named watchlist by importing a TradingView text file.
 * Returns structured failures instead of throwing so CLI and MCP callers get
 * the same diagnostics.
 */
export async function importWatchlist({
  file_path: filePath,
  name,
  require_paper_connected: requirePaperConnected = false,
  required_layout: requiredLayout,
  expected_pane_count: expectedPaneCount,
  dry_run: dryRun = false,
  _deps,
} = {}) {
  const context = emptyFailureContext();
  let driver = null;
  let fileInfo = null;
  let before = null;
  let chooserInterceptionEnabled = false;
  const normalizedName = normalizeLabel(name);

  try {
    validateOptions({ name: normalizedName, expectedPaneCount });
    const validateFile = _deps?.validateImportFile || validateImportFile;
    fileInfo = await validateFile(filePath, _deps);

    driver = _deps?.driver || createLiveDriver(_deps);
    await driver.prepare();
    before = await driver.inspectState();
    context.active_watchlist_before = before.active_watchlist;
    Object.assign(context, {
      layout: before.layout,
      pane_count: before.pane_count,
      paper_connected: before.paper_connected,
      live_broker_active: before.live_broker_active,
    });
    assertPreflight(before, { requiredLayout, expectedPaneCount, requirePaperConnected });

    // Interception is enabled before the first watchlist-menu open. It remains
    // enabled through retries and is always disabled in finally.
    await driver.setChooserInterception(true);
    chooserInterceptionEnabled = true;
    const menu = await driver.openMenu();
    context.visible_menu_item_labels = menu.labels || [];
    let uploadItem = findMenuItem(menu, isUploadLabel);

    if (dryRun) {
      if (!uploadItem) throw new ImportFailure('menu_validation', 'Watchlist upload/import action not found');
      await driver.closeMenu();
      context.active_watchlist_after = before.active_watchlist;
      return successResult('dry_run', before, fileInfo, 0, {
        state_changed: false,
        upload_control: uploadItem.label,
        menu_was_already_open: !!menu.was_already_open,
      });
    }

    if (before.active_watchlist === normalizedName) {
      await driver.closeMenu();
      verifyWatchlist(before, normalizedName);
      context.active_watchlist_after = before.active_watchlist;
      return successResult('already_current', before, fileInfo, 0, { state_changed: false });
    }

    const existing = await driver.selectExisting(normalizedName, menu);
    if (existing.selected) {
      context.state_changed = true;
      const selected = await waitForState(driver, state => state.active_watchlist === normalizedName);
      context.active_watchlist_after = selected?.active_watchlist || null;
      verifyWatchlist(selected || {}, normalizedName);
      return successResult('selected', selected, fileInfo, 0, { state_changed: true });
    }

    const currentMenu = existing.menu || menu;
    context.visible_menu_item_labels = currentMenu.labels || context.visible_menu_item_labels;
    uploadItem = findMenuItem(currentMenu, isUploadLabel);

    if (!uploadItem) throw new ImportFailure('menu_validation', 'Watchlist upload/import action not found');

    let uploadResult = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      context.retry_count = attempt;
      let attemptMenu = attempt === 0 ? currentMenu : await driver.openMenu();
      context.visible_menu_item_labels = attemptMenu.labels || context.visible_menu_item_labels;
      const currentUploadItem = findMenuItem(attemptMenu, isUploadLabel);
      if (!currentUploadItem) throw new ImportFailure('menu_validation', 'Watchlist upload/import action not found during retry');
      uploadResult = await driver.uploadFile(fileInfo.file_path, currentUploadItem);
      if (uploadResult?.file_assigned) break;
      if (uploadResult?.chooser_opened) {
        throw new ImportFailure('file_assignment', 'File chooser opened, but the import file could not be assigned; retry was blocked to prevent duplicates');
      }
      // No chooser means no file was assigned and no list can have been
      // created. This is the only failure that is safe to retry.
      if (attempt === 0) {
        await driver.closeMenu();
        continue;
      }
    }
    if (!uploadResult?.file_assigned) {
      throw new ImportFailure('file_chooser', 'TradingView file chooser did not open after two attempts');
    }
    context.state_changed = true;

    const imported = await waitForState(driver, state => isDistinctImportedList(before, state));
    context.active_watchlist_after = imported?.active_watchlist || null;
    if (!isDistinctImportedList(before, imported)) {
      throw new ImportFailure('post_import_detection', 'Could not verify that TradingView created a distinct imported watchlist');
    }

    if (imported.active_watchlist !== normalizedName) {
      await driver.renameActive(normalizedName);
    }
    const verified = await waitForState(driver, state => {
      if (state.active_watchlist !== normalizedName) return false;
      return missingRequiredSections(state).length === 0;
    });
    context.active_watchlist_after = verified?.active_watchlist || null;
    verifyWatchlist(verified || {}, normalizedName);
    return successResult('created', verified, fileInfo, context.retry_count, { state_changed: true });
  } catch (err) {
    if (err?.chooser_opened) context.state_changed = true;
    const failure = err instanceof ImportFailure
      ? err
      : new ImportFailure(err.stage || 'ui_interaction', err.message || String(err));
    let after = null;
    if (driver) {
      try { after = await driver.inspectState(); } catch {}
      try { context.screenshot_path = await driver.captureFailure(failure.stage); } catch {}
      try { await driver.closeMenu(); } catch {}
    }
    context.active_watchlist_after = after?.active_watchlist ?? context.active_watchlist_after;
    if (after) {
      context.layout = after.layout ?? context.layout;
      context.pane_count = after.pane_count ?? context.pane_count;
      context.paper_connected = after.paper_connected ?? context.paper_connected;
      context.live_broker_active = after.live_broker_active ?? context.live_broker_active;
    }
    const details = {
      stage: failure.stage,
      message: failure.message,
      ...context,
      ...(failure.invalid_tokens && { invalid_tokens: failure.invalid_tokens }),
    };
    return { success: false, error: details, ...details };
  } finally {
    if (chooserInterceptionEnabled && driver) {
      try { await driver.setChooserInterception(false); } catch {}
    }
  }
}
