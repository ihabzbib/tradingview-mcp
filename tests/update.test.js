/**
 * Tests for update() in src/core/update.js.
 * Covers guards (non-git, wrong branch, dirty tree, diverged) and the
 * update path (fast-forward, pnpm install only when the lockfile changed).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { update } from '../src/core/update.js';

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * Build DI deps simulating a git repo.
 * @param {object} opts — branch, dirty, remoteSha, ahead, behind, lockChanged
 */
function gitDeps({ branch = 'main', dirty = '', remoteSha = OLD, ahead = 0, behind = 0, lockChanged = false, pnpmFails = false } = {}) {
  const state = { merged: false, pnpmInstall: 0, cmds: [] };
  const deps = {
    existsSync: () => true,
    repoRoot: 'C:/fake/repo',
    execSync: (cmd) => {
      state.cmds.push(cmd);
      if (cmd.includes('rev-parse --abbrev-ref')) return branch;
      if (cmd.includes('status --porcelain')) return dirty;
      if (cmd.includes('rev-parse HEAD')) return state.merged ? remoteSha : OLD;
      if (cmd.includes('fetch origin')) return '';
      if (cmd.includes('rev-parse origin/main')) return remoteSha;
      if (cmd.includes('rev-list --count origin/main..HEAD')) return String(ahead);
      if (cmd.includes('rev-list --count HEAD..origin/main')) return String(behind);
      if (cmd.includes('diff --name-only')) return lockChanged ? 'pnpm-lock.yaml' : '';
      if (cmd.includes('merge --ff-only')) { state.merged = true; return ''; }
      if (cmd.startsWith('corepack pnpm install')) {
        state.pnpmInstall++;
        if (pnpmFails) throw new Error('EACCES');
        return '';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    },
  };
  return { deps, state };
}

describe('update() — guards', () => {
  it('refuses non-git installs with a clone hint', async () => {
    const { deps } = gitDeps();
    deps.existsSync = () => false;
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /git clone/);
  });

  it('refuses on a non-main branch', async () => {
    const { deps, state } = gitDeps({ branch: 'fix/my-feature' });
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.equal(r.branch, 'fix/my-feature');
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });

  it('refuses on a dirty working tree and lists changed files', async () => {
    const { deps, state } = gitDeps({ dirty: 'M src/core/data.js\n?? notes.txt' });
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.deepEqual(r.changed_files, ['M src/core/data.js', '?? notes.txt']);
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });

  it('refuses when local main has commits not on origin', async () => {
    const { deps, state } = gitDeps({ remoteSha: NEW, ahead: 2, behind: 5 });
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /fast-forward is not possible/);
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });

  it('reports fetch failures without merging', async () => {
    const { deps, state } = gitDeps();
    const orig = deps.execSync;
    deps.execSync = (cmd) => { if (cmd.includes('fetch')) throw new Error('could not resolve host'); return orig(cmd); };
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /fetch failed/);
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });
});

describe('update() — update paths', () => {
  it('reports up_to_date without merging when HEAD matches origin', async () => {
    const { deps, state } = gitDeps({ remoteSha: OLD });
    const r = await update({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.updated, false);
    assert.equal(r.status, 'up_to_date');
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });

  it('fast-forwards and skips pnpm install when the lockfile is unchanged', async () => {
    const { deps, state } = gitDeps({ remoteSha: NEW, behind: 3 });
    const r = await update({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.updated, true);
    assert.equal(r.commits_pulled, 3);
    assert.equal(r.from_commit, OLD.slice(0, 8));
    assert.equal(r.to_commit, NEW.slice(0, 8));
    assert.equal(r.deps_installed, false);
    assert.equal(state.pnpmInstall, 0);
    assert.equal(r.restart_required, true);
  });

  it('runs pnpm install when the lockfile changed', async () => {
    const { deps, state } = gitDeps({ remoteSha: NEW, behind: 1, lockChanged: true });
    const r = await update({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.deps_installed, true);
    assert.equal(state.pnpmInstall, 1);
  });

  it('still reports the code update when pnpm install fails, with a warning', async () => {
    const { deps } = gitDeps({ remoteSha: NEW, behind: 1, lockChanged: true, pnpmFails: true });
    const r = await update({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.updated, true);
    assert.equal(r.deps_installed, false);
    assert.match(r.warning, /pnpm install failed/);
  });
});
