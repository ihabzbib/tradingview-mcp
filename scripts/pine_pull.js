#!/usr/bin/env node
// Backward-compatible wrapper: use the CLI `tv pine pull` implementation.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../src/cli/index.js');
const result = spawnSync(process.execPath, [cli, 'pine', 'pull', ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 0);
