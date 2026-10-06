import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const jwt = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

async function javascript(profile: string): Promise<string> {
  const directory = path.join(root, 'dist', profile);
  const files = (await readdir(directory)).filter((file) => file.endsWith('.js') || file.endsWith('.html'));
  const parts = await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8')));
  return parts.join('\n');
}

test('EXT-12 built bundles contain no token, eval, or remote script', async () => {
  for (const profile of ['staging', 'production', 'e2e']) {
    const source = await javascript(profile);
    assert.equal(source.includes('eval('), false, profile);
    assert.equal(source.includes('new Function('), false, profile);
    assert.equal(/<script[^>]+src=["']https?:/i.test(source), false, profile);
    assert.equal(/import\s*\(\s*["']https?:/i.test(source), false, profile);
    assert.equal(jwt.test(source), false, profile);
    assert.equal(source.includes('.storage.local'), false, profile);
    assert.equal(source.includes('.storage.sync'), false, profile);
    assert.equal(source.includes('onMessageExternal'), false, profile);
  }
  const production = await javascript('production');
  assert.match(production, /name:"production",origin:"https:\/\/freetwai\.com",environment:"next"/);
  assert.equal(production.includes('name:"production",origin:"https://staging.freetwai.com"'), false);
  assert.equal(production.includes('loopback:!0'), false);
  assert.equal(production.includes('http://127.0.0.1:4391'), false);
  const staging = await javascript('staging');
  assert.match(staging, /origin:"https:\/\/staging\.freetwai\.com"/);
  assert.equal(staging.includes('http://127.0.0.1:4391'), false);
});
