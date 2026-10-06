import type { RuntimeEnvironment } from './profile.ts';

export interface EnrollmentChallenge {
  profile: 'freedom.runtime-enrollment/v1';
  purpose: 'runtime_enrollment';
  challenge_id: string;
  owner_member_id: string;
  owner_principal_id: string;
  scope_id: string;
  runtime_device_id: string;
  environment: RuntimeEnvironment;
  key_thumbprint: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
  operational_authority: false;
  payload: string;
}

export interface RefreshMaterial {
  familyId: string;
  generation: string;
  handle: string;
  expiresAt: string;
}

export interface PersistedPairing {
  v: 1;
  epoch: number;
  phase: 'disconnected' | 'beginning' | 'waiting' | 'connected' | 'revoked' | 'expired' | 'reconnect';
  reason: string | null;
  /** Set immediately before an enrollment proof is sent. A later load must not send it again. */
  enrollmentArmed: boolean;
  /** Set immediately before a refresh is sent. A later load must not send that handle again. */
  refreshArmed: boolean;
  authorizationId: string | null;
  deviceCode: string | null;
  userCode: string | null;
  nonce: string | null;
  requestDigest: string | null;
  verificationUri: string | null;
  expiresAt: string | null;
  intervalSeconds: number | null;
  nextPollAt: number | null;
  challenge: EnrollmentChallenge | null;
  accessToken: string | null;
  connectionId: string | null;
  runtimeDeviceId: string | null;
  refresh: RefreshMaterial | null;
  tokenExpiresAt: string | null;
  lastStatusAt: number | null;
}

export function blankPairing(epoch: number, phase: PersistedPairing['phase'], reason: string | null): PersistedPairing {
  return {
    v: 1,
    epoch,
    phase,
    reason,
    enrollmentArmed: false,
    refreshArmed: false,
    authorizationId: null,
    deviceCode: null,
    userCode: null,
    nonce: null,
    requestDigest: null,
    verificationUri: null,
    expiresAt: null,
    intervalSeconds: null,
    nextPollAt: null,
    challenge: null,
    accessToken: null,
    connectionId: null,
    runtimeDeviceId: null,
    refresh: null,
    tokenExpiresAt: null,
    lastStatusAt: null,
  };
}
