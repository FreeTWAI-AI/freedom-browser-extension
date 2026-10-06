import type { BuildProfile } from '../../src/profile.ts';

export const stagingProfile: BuildProfile = Object.freeze({
  name: 'staging',
  origin: 'https://staging.freetwai.com',
  environment: 'staging-next',
  clientId: 'freedom-browser-extension',
  loopback: false,
  statusRecheckMs: 60_000,
});

export const e2eProfile: BuildProfile = Object.freeze({
  name: 'e2e',
  origin: 'http://127.0.0.1:4391',
  environment: 'local',
  clientId: 'freedom-browser-extension',
  loopback: true,
  statusRecheckMs: 400,
});
