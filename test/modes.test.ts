import assert from 'node:assert/strict';
import test from 'node:test';
import { readModes } from '../src/modes.ts';
import { createFakeChrome } from './support/fake-chrome.ts';

test('EXT-01 no Native Host keeps BYOK available and CLI missing', async () => {
  const fake = createFakeChrome();
  const missing = await readModes(fake.chrome, 0);
  assert.deepEqual(missing, { extension_byok: 'available', extension_cli: 'missing' });
  assert.equal(fake.counts.connectNative, 0);

  fake.grantPermission('nativeMessaging');
  fake.setNative('throw');
  const thrown = await readModes(fake.chrome, 0);
  assert.equal(thrown.extension_cli, 'missing');

  fake.setNative('drop');
  const dropped = await readModes(fake.chrome, 0);
  assert.equal(dropped.extension_byok, 'available');
  assert.equal(dropped.extension_cli, 'missing');

  fake.setNative('stay');
  const stayed = await readModes(fake.chrome, 0);
  assert.equal(stayed.extension_cli, 'available');
});
