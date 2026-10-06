import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryKeyStore } from '../src/device-key.ts';

test('the device private key is nonextractable', async () => {
  const store = createMemoryKeyStore();
  const key = await store.create();
  assert.equal(key.privateKey.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey('jwk', key.privateKey));
  const exported = await crypto.subtle.exportKey('jwk', key.publicKey);
  assert.equal(exported.d, undefined);
  assert.deepEqual(key.jwk, { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y });
  await store.destroy();
  assert.equal(await store.load(), null);
});
