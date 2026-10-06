import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProfile } from '../src/profile.ts';
import { e2eProfile, stagingProfile } from './support/profiles.ts';

test('staging and production reject a loopback or swapped origin', () => {
  assert.doesNotThrow(() => assertProfile(stagingProfile));
  assert.throws(() => assertProfile({ ...stagingProfile, origin: 'http://127.0.0.1:4391', loopback: true }), /configuration_invalid/);
  assert.throws(() => assertProfile({ ...stagingProfile, origin: 'https://freetwai.com' }), /configuration_invalid/);
  assert.throws(() => assertProfile({
    name: 'production',
    origin: 'http://127.0.0.1:4391',
    environment: 'next',
    clientId: 'freedom-browser-extension',
    loopback: false,
    statusRecheckMs: 60_000,
  }), /configuration_invalid/);
  assert.doesNotThrow(() => assertProfile({
    name: 'production',
    origin: 'https://freetwai.com',
    environment: 'next',
    clientId: 'freedom-browser-extension',
    loopback: false,
    statusRecheckMs: 60_000,
  }));
  assert.doesNotThrow(() => assertProfile(e2eProfile));
  assert.throws(() => assertProfile({ ...e2eProfile, origin: 'http://127.0.0.1:4392' }), /configuration_invalid/);
});
