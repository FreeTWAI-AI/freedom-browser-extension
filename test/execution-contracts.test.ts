import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('vendored execution contracts match the unpublished pin', async () => {
  const lock = JSON.parse(await readFile(path.join(root, 'execution-contracts.lock.json'), 'utf8')) as {
    format: string;
    note: string;
    source_repository: string;
    source_commit: string;
    files: Array<{ source_path: string; vendor_path: string; sha256: string; bytes: number }>;
  };
  assert.equal(lock.format, 'freedom.execution-contract-pin/v0-unpublished');
  assert.match(lock.note, /not a released consumer bundle/i);
  assert.equal(lock.source_repository, 'FreeTWAI-AI/freedom-platform');
  assert.equal(lock.source_commit, 'd1c9e18fffabebbdceaba233a34f3605220e2dd7');
  const directory = path.join(root, 'vendor', 'freedom-platform-execution', 'v1');
  const present = new Set(await readdir(directory));
  const listed = new Set(lock.files.map((file) => path.basename(file.vendor_path)));
  assert.deepEqual([...present].sort(), [...listed].sort());
  for (const file of lock.files) {
    const bytes = await readFile(path.join(root, file.vendor_path));
    assert.equal(bytes.byteLength, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(file.vendor_path, `vendor/freedom-platform-execution/v1/${path.basename(file.source_path)}`);
  }
});
