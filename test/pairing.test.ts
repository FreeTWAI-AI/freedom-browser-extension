import assert from 'node:assert/strict';
import test from 'node:test';
import { signCompact } from '../src/codec.ts';
import { createMemoryKeyStore } from '../src/device-key.ts';
import { createPairingClient } from '../src/pairing-client.ts';
import { blankPairing } from '../src/pairing-state.ts';
import { assertCredentialArea, createChromeSessionStore, createMemorySessionStore } from '../src/session-store.ts';
import { createClock } from './support/clock.ts';
import { createFakeChrome } from './support/fake-chrome.ts';
import { createFakePlatform } from './support/fake-platform.ts';
import { stagingProfile } from './support/profiles.ts';

async function setup() {
  const clock = createClock();
  const platform = createFakePlatform({
    clock,
    origin: stagingProfile.origin,
    clientId: stagingProfile.clientId,
    environment: stagingProfile.environment,
  });
  const keys = createMemoryKeyStore();
  const store = createMemorySessionStore();
  const client = await createPairingClient({ profile: stagingProfile, fetchImpl: platform.fetchImpl, clock, keys, store });
  return { clock, platform, keys, store, client };
}

async function connect(fixture: Awaited<ReturnType<typeof setup>>) {
  const started = await fixture.client.begin();
  assert.equal(started.phase, 'waiting');
  assert.ok(started.userCode);
  fixture.platform.approve(started.userCode);
  const challenged = await fixture.client.poll();
  assert.equal(challenged.phase, 'waiting');
  fixture.clock.advance(5000);
  const issued = await fixture.client.poll();
  assert.equal(issued.phase, 'connected');
  return issued;
}

test('pairs through proof_required and reads bootstrap status', async () => {
  const fixture = await setup();
  await connect(fixture);
  const status = await fixture.client.readStatus();
  assert.equal(status.phase, 'connected');
  assert.ok(fixture.platform.verified.signature > 0);
  assert.ok(fixture.platform.verified.htm > 0);
  assert.ok(fixture.platform.verified.htu > 0);
  assert.ok(fixture.platform.verified.jti > 0);
  assert.ok(fixture.platform.verified.nonce > 0);
  assert.ok(fixture.platform.verified.ath > 0);
  const raw = fixture.store.raw();
  assert.equal(status.userCode, null);
  assert.ok(raw?.accessToken);
  assert.equal(JSON.stringify(status).includes(raw?.accessToken ?? 'missing-token'), false);
});

test('DPoP rejects a bad signature, htm, htu, replayed jti, nonce, and access-token hash', async () => {
  const fixture = await setup();
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: exported.x!, y: exported.y! };
  const htu = `${stagingProfile.origin}/execution-api/v1/auth/device-authorizations`;
  const claims = {
    purpose: 'device_pairing_begin',
    client_id: stagingProfile.clientId,
    environment: stagingProfile.environment,
    jti: 'replay-jti-value-0123456789abcd',
    iat: Math.floor(fixture.clock.now() / 1000),
    htm: 'POST',
    htu,
  };
  const proof = await signCompact(pair.privateKey, { alg: 'ES256', typ: 'freedom-device-pairing+jwt', jwk }, claims);
  const ok = await fixture.platform.assess(proof, { htm: 'POST', htu });
  assert.equal(ok.ok, true);
  const replay = await fixture.platform.assess(proof, { htm: 'POST', htu });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.reason, 'jti');

  const badHtm = await signCompact(pair.privateKey, { alg: 'ES256', typ: 'freedom-device-pairing+jwt', jwk }, { ...claims, jti: 'other-jti-value-0123456789abcd', htm: 'GET' });
  const htm = await fixture.platform.assess(badHtm, { htm: 'POST', htu });
  assert.equal(htm.ok, false);
  if (!htm.ok) assert.equal(htm.reason, 'htm');

  const badHtu = await signCompact(pair.privateKey, { alg: 'ES256', typ: 'freedom-device-pairing+jwt', jwk }, { ...claims, jti: 'third-jti-value-0123456789abcd', htu: `${stagingProfile.origin}/elsewhere` });
  const htuResult = await fixture.platform.assess(badHtu, { htm: 'POST', htu });
  assert.equal(htuResult.ok, false);
  if (!htuResult.ok) assert.equal(htuResult.reason, 'htu');

  const tampered = `${proof.slice(0, -4)}aaaa`;
  const signature = await fixture.platform.assess(tampered, { htm: 'POST', htu });
  assert.equal(signature.ok, false);
  if (!signature.ok) assert.equal(signature.reason, 'signature');

  const nonceProof = await signCompact(pair.privateKey, { alg: 'ES256', typ: 'dpop+jwt', jwk }, { ...claims, jti: 'nonce-jti-value-0123456789abcd', nonce: 'wrong-nonce', ath: 'wrong' });
  const nonce = await fixture.platform.assess(nonceProof, { htm: 'POST', htu, nonce: 'expected-nonce', ath: 'expected-ath', accessToken: 'token-value' });
  assert.equal(nonce.ok, false);
  if (!nonce.ok) assert.equal(nonce.reason, 'nonce');

  const athProof = await signCompact(pair.privateKey, { alg: 'ES256', typ: 'dpop+jwt', jwk }, { ...claims, jti: 'ath-jti-value-0123456789abcdef', nonce: 'expected-nonce', ath: 'wrong-ath' });
  const ath = await fixture.platform.assess(athProof, { htm: 'POST', htu, nonce: 'expected-nonce', ath: 'expected-ath', accessToken: 'token-value' });
  assert.equal(ath.ok, false);
  if (!ath.ok) assert.equal(ath.reason, 'ath');
});

test('expired code, denied decision, and slow_down backoff', async () => {
  const expired = await setup();
  await expired.client.begin();
  expired.clock.advance(300_000);
  const expiredView = await expired.client.poll();
  assert.equal(expiredView.phase, 'expired');
  assert.equal(expired.platform.counts.token, 0);

  const denied = await setup();
  const waiting = await denied.client.begin();
  denied.platform.deny(waiting.userCode ?? '');
  const deniedView = await denied.client.poll();
  assert.equal(deniedView.phase, 'reconnect');
  assert.equal(deniedView.reason, 'denied');

  const slowed = await setup();
  await slowed.client.begin();
  slowed.platform.forceSlowDown = true;
  await slowed.client.poll();
  const before = slowed.platform.counts.token;
  slowed.clock.advance(1000);
  await slowed.client.poll();
  assert.equal(slowed.platform.counts.token, before);
  slowed.clock.advance(9000);
  await slowed.client.poll();
  assert.equal(slowed.platform.counts.token, before + 1);
});

test('redirect, malformed, oversize, and abort quarantine the exchange', async () => {
  for (const mode of ['redirect', 'redirect-status', 'malformed', 'oversize', 'abort', 'lost'] as const) {
    const fixture = await setup();
    fixture.platform.failNext = mode;
    const view = await fixture.client.begin();
    assert.equal(view.phase, 'reconnect', mode);
    assert.notEqual(view.reason, null, mode);
    const calls = fixture.platform.counts.begin + fixture.platform.counts.token;
    await fixture.client.poll();
    assert.equal(fixture.platform.counts.begin + fixture.platform.counts.token, calls, mode);
  }
});

test('refresh reuse revokes the session and wipes tokens', async () => {
  const fixture = await setup();
  await connect(fixture);
  fixture.platform.consumeCurrentHandle();
  const view = await fixture.client.refresh();
  assert.equal(view.phase, 'revoked');
  assert.equal(fixture.store.raw()?.accessToken, null);
  assert.equal(fixture.store.raw()?.refresh, null);
});

test('an armed exchange is not sent again after reload', async () => {
  const clock = createClock();
  const platform = createFakePlatform({ clock, origin: stagingProfile.origin, clientId: stagingProfile.clientId, environment: stagingProfile.environment });
  const keys = createMemoryKeyStore();
  await keys.create();
  const store = createMemorySessionStore();
  const armed = blankPairing(2, 'waiting', null);
  armed.enrollmentArmed = true;
  armed.userCode = 'ABCDE-FGHJK';
  await store.write(armed);
  const client = await createPairingClient({ profile: stagingProfile, fetchImpl: platform.fetchImpl, clock, keys, store });
  assert.equal(client.view().phase, 'reconnect');
  assert.equal(client.view().reason, 'exchange_outcome_unknown');
  assert.equal(platform.counts.token, 0);
  assert.equal(store.raw()?.deviceCode, null);
});

test('EXT-12 rejects token writes outside session storage', async () => {
  assert.throws(() => assertCredentialArea('local', { accessToken: 'secret' }), /credential_storage_rejected/);
  assert.throws(() => assertCredentialArea('sync', { refreshHandle: 'secret' }), /credential_storage_rejected/);
  assert.throws(() => assertCredentialArea('local', { deviceCode: 'secret' }), /credential_storage_rejected/);
  assert.throws(() => assertCredentialArea('sync', { blob: 'eyJaaaaaaaaaa.bbbbbbbbbbb.signature' }), /credential_storage_rejected/);

  const fake = createFakeChrome();
  const clock = createClock();
  const platform = createFakePlatform({ clock, origin: stagingProfile.origin, clientId: stagingProfile.clientId, environment: stagingProfile.environment });
  const store = createChromeSessionStore(fake.session);
  const client = await createPairingClient({
    profile: stagingProfile,
    fetchImpl: platform.fetchImpl,
    clock,
    keys: createMemoryKeyStore(),
    store,
  });
  const started = await client.begin();
  platform.approve(started.userCode ?? '');
  await client.poll();
  clock.advance(5000);
  await client.poll();
  await client.readStatus();
  assert.equal(fake.counts.localSet, 0);
  assert.equal(fake.counts.syncSet, 0);
  const saved = JSON.stringify(fake.session.values.get('freedom.pairing'));
  assert.match(saved, /accessToken/);
  assert.equal([...fake.local.values.keys()].length, 0);
  assert.equal([...fake.sync.values.keys()].length, 0);
});
