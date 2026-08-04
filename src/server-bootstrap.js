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
  try {
    const dotenv = await import('dotenv');
    const result = dotenv.config({ path: envFile, quiet: true });
    if (result.error && result.error.code !== 'ENOENT') {
      process.stderr.write(
        '⚠  tradingview-mcp  |  Could not load .env via dotenv, using process environment instead. ' +
          `${result.error.message}\n`,
      );
    }
  } catch {
    process.stderr.write(
      '⚠  tradingview-mcp  |  dotenv is unavailable and process.loadEnvFile() is not supported. ' +
        'Using only process-level environment variables.\n',
    );
  }
}

await import('./server.js');
