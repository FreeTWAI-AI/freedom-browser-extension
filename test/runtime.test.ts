import assert from 'node:assert/strict';
import test from 'node:test';
import { startRuntime } from '../src/background/runtime.ts';
import { createMemoryKeyStore } from '../src/device-key.ts';
import { createPairingClient } from '../src/pairing-client.ts';
import { createChromeSessionStore, createMemorySessionStore } from '../src/session-store.ts';
import type { ExtensionSnapshot } from '../src/messages.ts';
import type { MessageSender } from '../src/messages.ts';
import { createClock } from './support/clock.ts';
import { createFakeChrome } from './support/fake-chrome.ts';
import { createFakePlatform } from './support/fake-platform.ts';
import { stagingProfile } from './support/profiles.ts';

const runtimeId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function panel(epoch: number): MessageSender {
  return { id: runtimeId, url: `chrome-extension://${runtimeId}/index.html` };
}

test('EXT-04 revoked pairing wipes tokens while the host permission remains', async () => {
  const fake = createFakeChrome(runtimeId);
  const clock = createClock();
  const platform = createFakePlatform({
    clock,
    origin: stagingProfile.origin,
    clientId: stagingProfile.clientId,
    environment: stagingProfile.environment,
  });
  const store = createChromeSessionStore(fake.session);
  const runtime = await startRuntime({
    profile: stagingProfile,
    fetchImpl: platform.fetchImpl,
    clock,
    keys: createMemoryKeyStore(),
    store,
    chrome: fake.chrome,
    schedule: false,
  });
  assert.equal(fake.alarmName(), 'freedom.maintenance');
  const began = await fake.send({ type: 'pairing.begin', epoch: 1 }, panel(1)) as { ok: boolean; snapshot: ExtensionSnapshot };
  assert.equal(began.ok, true);
  assert.equal(began.snapshot.phase, 'waiting');
  platform.approve(began.snapshot.userCode ?? '');
  await runtime.pump();
  clock.advance(5000);
  await runtime.pump();
  const connected = await runtime.snapshot();
  assert.equal(connected.phase, 'connected');
  fake.grantOrigin('https://a.example');
  const started = await fake.send({
    type: 'site.start',
    epoch: connected.epoch,
    origin: 'https://a.example',
    tabId: 4,
  }, panel(connected.epoch)) as { ok: boolean; snapshot: ExtensionSnapshot };
  assert.equal(started.ok, true);
  assert.equal(started.snapshot.sites[0]?.state, 'pending');
  platform.revoke(connected.connectionId ?? undefined);
  clock.advance(60_000);
  await runtime.pump();
  const revoked = await runtime.snapshot();
  assert.equal(revoked.phase, 'revoked');
  assert.equal(revoked.sites[0]?.message, '連線已結束，網站工作階段已停止');
  assert.equal(fake.hasOrigin('https://a.example'), true);
  const saved = fake.session.values.get('freedom.pairing') as { accessToken: string | null; refresh: unknown; deviceCode: string | null };
  assert.equal(saved.accessToken, null);
  assert.equal(saved.refresh, null);
  assert.equal(saved.deviceCode, null);
  const again = await fake.send({
    type: 'site.start',
    epoch: revoked.epoch,
    origin: 'https://a.example',
    tabId: 4,
  }, panel(revoked.epoch)) as { ok: boolean };
  assert.equal(again.ok, false);
  assert.equal(fake.counts.localSet, 0);
  assert.equal(fake.counts.syncSet, 0);
  runtime.stop();
});

test('EXT-03 a granted site does not follow a redirect to another origin', async () => {
  const fake = createFakeChrome(runtimeId);
  const clock = createClock();
  const platform = createFakePlatform({
    clock,
    origin: stagingProfile.origin,
    clientId: stagingProfile.clientId,
    environment: stagingProfile.environment,
  });
  const runtime = await startRuntime({
    profile: stagingProfile,
    fetchImpl: platform.fetchImpl,
    clock,
    keys: createMemoryKeyStore(),
    store: createChromeSessionStore(fake.session),
    chrome: fake.chrome,
    schedule: false,
  });
  const began = await fake.send({ type: 'pairing.begin', epoch: 1 }, panel(1)) as { snapshot: ExtensionSnapshot };
  platform.approve(began.snapshot.userCode ?? '');
  await runtime.pump();
  clock.advance(5000);
  await runtime.pump();
  const connected = await runtime.snapshot();
  fake.grantOrigin('https://a.example');
  await fake.send({ type: 'site.start', epoch: connected.epoch, origin: 'https://a.example', tabId: 9 }, panel(connected.epoch));
  fake.emitUpdated(9, 'https://b.example/after-redirect');
  const stopped = await runtime.snapshot();
  assert.equal(stopped.sites[0]?.message, '需要重新授權這個網站');
  assert.equal(stopped.sites[0]?.state, 'stopped');
  assert.equal(fake.hasOrigin('https://a.example'), true);
  runtime.stop();
});

test('EXT-06 fresh session storage requires pairing again', async () => {
  const clock = createClock();
  const platform = createFakePlatform({
    clock,
    origin: stagingProfile.origin,
    clientId: stagingProfile.clientId,
    environment: stagingProfile.environment,
  });
  const keys = createMemoryKeyStore();
  const first = createMemorySessionStore();
  const client = await createPairingClient({ profile: stagingProfile, fetchImpl: platform.fetchImpl, clock, keys, store: first });
  const started = await client.begin();
  platform.approve(started.userCode ?? '');
  await client.poll();
  clock.advance(5000);
  await client.poll();
  const oldToken = first.raw()?.accessToken;
  assert.ok(oldToken);
  const restarted = await createPairingClient({
    profile: stagingProfile,
    fetchImpl: platform.fetchImpl,
    clock,
    keys,
    store: createMemorySessionStore(),
  });
  assert.equal(restarted.view().phase, 'disconnected');
  const before = platform.requests.length;
  await restarted.begin();
  const later = JSON.stringify(platform.requests.slice(before));
  assert.equal(later.includes(oldToken ?? ''), false);
});
