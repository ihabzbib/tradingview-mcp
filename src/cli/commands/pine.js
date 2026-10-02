import { register } from '../router.js';
import * as core from '../../core/pine.js';
import { readFileSync } from 'fs';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const THIS_FILE = fileURLToPath(import.meta.url);
const CURRENT_PINE_PATH = resolve(dirname(THIS_FILE), '../../../scripts/current.pine');

function sourcePath(filePath) {
  return filePath ? resolve(filePath) : CURRENT_PINE_PATH;
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

register('pine', {
  description: 'Pine Script tools',
  subcommands: new Map([
    ['get', {
      description: 'Get current Pine Script source from editor',
      handler: () => core.getSource(),
    }],
    ['set', {
      description: 'Set Pine Script source (reads stdin or --file)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.setSource({ source });
      },
    }],
    ['compile', {
      description: 'Smart compile: detect button, compile, check errors',
      handler: () => core.smartCompile(),
    }],
    ['raw-compile', {
      description: 'Click compile/add button without smart detection',
      handler: () => core.compile(),
    }],
    ['analyze', {
      description: 'Offline static analysis (no TradingView needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.analyze({ source });
      },
    }],
    ['check', {
      description: 'Server-side compile check (no chart needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.check({ source });
      },
    }],
    ['save', {
      description: 'Save the current Pine Script (Ctrl+S)',
      handler: () => core.save(),
    }],
    ['new', {
      description: 'Create a new blank Pine Script (indicator, strategy, library)',
      handler: (opts, positionals) => {
        const type = positionals[0] || 'indicator';
        return core.newScript({ type });
      },
    }],
    ['open', {
      description: 'Open a saved Pine Script by name',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Script name required. Usage: tv pine open "My Script"');
        return core.openScript({ name: positionals.join(' ') });
      },
    }],
    ['list', {
      description: 'List saved Pine Scripts',
      handler: () => core.listScripts(),
    }],
    ['errors', {
      description: 'Get Pine Script compilation errors',
      handler: () => core.getErrors(),
    }],
    ['console', {
      description: 'Get Pine Script console/log output',
      handler: () => core.getConsole(),
    }],
    ['pull', {
      description: 'Pull current Pine Script source from TradingView into scripts/current.pine',
      options: {
        file: { type: 'string', short: 'f', description: 'Write source to this file (default: scripts/current.pine)' },
      },
      handler: async (opts) => {
        const source_path = sourcePath(opts.file);
        const fetched = await core.getSource();
        writeFileSync(source_path, fetched.source || '', 'utf-8');
        return {
          success: true,
          action: 'pull',
          source_path,
          bytes_written: (fetched.source || '').length,
          line_count: (fetched.source || '').split('\n').length,
          char_count: (fetched.source || '').length,
        };
      },
    }],
    ['push', {
      description: 'Push scripts/current.pine into TradingView and smart-compile',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from this file (default: scripts/current.pine)' },
      },
      handler: async (opts) => {
        const source_path = sourcePath(opts.file);
        const source = readFileSync(source_path, 'utf-8');
        const set = await core.setSource({ source });
        const compile = await core.smartCompile();
        return {
          success: true,
          action: 'push',
          source_path,
          lines_set: set.lines_set,
          button_clicked: compile.button_clicked,
          has_errors: compile.has_errors,
          errors: compile.errors,
          study_added: compile.study_added,
        };
      },
    }],
  ]),
});
