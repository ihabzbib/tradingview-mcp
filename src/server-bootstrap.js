import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    process.stderr.write(
      '⚠  tradingview-mcp  |  Could not load .env file, using process environment instead. ' +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
} else {
  process.stderr.write(
    '⚠  tradingview-mcp  |  Node.js version does not support process.loadEnvFile(). ' +
      'Using only process-level environment variables.\n',
  );
}

await import('./server.js');
