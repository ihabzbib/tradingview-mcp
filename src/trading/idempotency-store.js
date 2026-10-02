import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function recordName(approvalId) {
  return `${createHash('sha256').update(approvalId).digest('hex')}.json`;
}

export function defaultIdempotencyRoot(policy) {
  return policy.idempotency_dir || join(homedir(), '.tradingview-mcp', 'trading-idempotency');
}

export class FileIdempotencyStore {
  constructor(root) {
    this.root = root;
  }

  pathFor(approvalId) {
    return join(this.root, recordName(approvalId));
  }

  async get(approvalId) {
    try {
      return JSON.parse(await readFile(this.pathFor(approvalId), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async begin(approvalId, fingerprint, operation, now = new Date().toISOString()) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const record = { approval_id: approvalId, fingerprint, operation, status: 'pending', created_at: now };
    try {
      await writeFile(this.pathFor(approvalId), `${JSON.stringify(record, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      return { created: true, record };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return { created: false, record: await this.get(approvalId) };
    }
  }

  async complete(approvalId, fingerprint, result, now = new Date().toISOString()) {
    const path = this.pathFor(approvalId);
    const record = await this.get(approvalId);
    if (!record || record.fingerprint !== fingerprint) {
      throw new Error('Cannot complete an absent or mismatched approval record');
    }
    const completed = { ...record, status: 'completed', completed_at: now, result };
    const temp = join(dirname(path), `.${recordName(approvalId)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temp, `${JSON.stringify(completed, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
    return completed;
  }
}

