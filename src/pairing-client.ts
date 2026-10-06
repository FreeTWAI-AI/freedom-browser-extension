import {
  type PublicJwk,
  ProtocolError,
  check,
  compactPattern,
  exactKeys,
  isBytes32,
  isIsoTime,
  isUuid,
  isVersion,
  randomJti,
  sha256b64,
  signCompact,
  userCodePattern,
} from './codec.ts';
import type { DeviceKey, DeviceKeyStore } from './device-key.ts';
import { exchange } from './http-exchange.ts';
import { PATHS } from './paths.ts';
import { type EnrollmentChallenge, type PersistedPairing, blankPairing } from './pairing-state.ts';
import { type BuildProfile, type RuntimeEnvironment, assertProfile } from './profile.ts';
import type { SessionStore } from './session-store.ts';

export type PublicPhase = 'disconnected' | 'waiting' | 'connected' | 'revoked' | 'expired' | 'reconnect';

export interface PublicView {
  phase: PublicPhase;
  reason: string | null;
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: string | null;
  connectionId: string | null;
  epoch: number;
  pollAfterMs: number;
}

export interface Clock {
  now(): number;
}

export interface PairingClient {
  begin(): Promise<PublicView>;
  poll(): Promise<PublicView>;
  refresh(): Promise<PublicView>;
  readStatus(): Promise<PublicView>;
  disconnect(): Promise<PublicView>;
  view(): PublicView;
  verificationUri(): string | null;
  shouldRecheck(intervalMs: number): boolean;
}

const encoder = new TextEncoder();
const noAuthority = (value: unknown) => value === false;
const literal = (expected: unknown) => (value: unknown) => value === expected;

function asRecord(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function verificationUriOk(value: unknown, origin: string): boolean {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.origin === origin && url.href === value && !url.username && !url.password && !/[?#%\\\x00-\x20\x7f-\uffff]/.test(value);
  } catch {
    return false;
  }
}

function publicPhase(phase: PersistedPairing['phase']): PublicPhase {
  if (phase === 'beginning') return 'disconnected';
  return phase;
}

export async function createPairingClient(options: {
  profile: BuildProfile;
  fetchImpl: typeof fetch;
  clock: Clock;
  keys: DeviceKeyStore;
  store: SessionStore;
}): Promise<PairingClient> {
  assertProfile(options.profile);
  const { profile, fetchImpl, clock, keys, store } = options;
  let state = normalize(await store.read());
  let device = await keys.load();
  let busy = false;
  if (state.enrollmentArmed || state.refreshArmed || state.phase === 'beginning') {
    await quarantine('exchange_outcome_unknown');
  } else if ((state.phase === 'waiting' || state.phase === 'connected') && !device) {
    await quarantine('device_key_missing');
  } else if (state.phase === 'waiting' && state.expiresAt && clock.now() >= Date.parse(state.expiresAt)) {
    await commit(blankPairing(state.epoch + 1, 'expired', 'expired_token'));
  }

  function view(): PublicView {
    const phase = publicPhase(state.phase);
    const pollAfterMs = phase === 'waiting' && state.nextPollAt !== null ? Math.max(0, state.nextPollAt - clock.now()) : 0;
    return {
      phase,
      reason: state.reason,
      userCode: phase === 'waiting' ? state.userCode : null,
      verificationUri: phase === 'waiting' ? state.verificationUri : null,
      expiresAt: phase === 'waiting' ? state.expiresAt : phase === 'connected' ? state.tokenExpiresAt : null,
      connectionId: phase === 'connected' ? state.connectionId : null,
      epoch: state.epoch,
      pollAfterMs,
    };
  }

  async function commit(next: PersistedPairing): Promise<void> {
    state = next;
    await store.write(next);
    const terminal = next.phase === 'disconnected' || next.phase === 'revoked' || next.phase === 'expired' || next.phase === 'reconnect';
    if (terminal) {
      device = null;
      await keys.destroy();
    }
  }

  async function quarantine(reason: string): Promise<void> {
    await commit(blankPairing(state.epoch + 1, 'reconnect', reason));
  }

  async function exclusive(run: () => Promise<void>): Promise<PublicView> {
    if (busy) throw new ProtocolError('operation_in_progress');
    busy = true;
    try {
      await run();
      return view();
    } finally {
      busy = false;
    }
  }

  function requireDevice(): DeviceKey {
    if (!device) throw new ProtocolError('device_key_missing');
    return device;
  }

  async function postProof(path: keyof typeof PATHS, headerTyp: string, payload: object | string, enrollment = false): Promise<string> {
    const current = requireDevice();
    const header = enrollment
      ? { alg: 'ES256', typ: headerTyp }
      : { alg: 'ES256', typ: headerTyp, jwk: current.jwk };
    return signCompact(current.privateKey, header, payload);
  }

  function claims(purpose: string, path: string): Record<string, unknown> {
    return {
      purpose,
      client_id: profile.clientId,
      environment: profile.environment,
      jti: randomJti(),
      iat: Math.floor(clock.now() / 1000),
      htm: 'POST',
      htu: profile.origin + PATHS[path as 'begin'],
    };
  }

  async function call(path: keyof typeof PATHS, method: 'GET' | 'POST', body: unknown, headers: Record<string, string>, expectedStatus: number): Promise<unknown> {
    return exchange({
      fetchImpl,
      url: profile.origin + PATHS[path],
      method,
      body,
      headers,
      expectedStatus,
    });
  }

  async function failCall(kind: 'begin' | 'poll' | 'refresh' | 'status', error: unknown): Promise<void> {
    const protocol = error instanceof ProtocolError ? error : new ProtocolError('transport_failed');
    const rejected = protocol.code === 'http_rejected' && (protocol.status === 401 || protocol.status === 403);
    if ((kind === 'refresh' || kind === 'status') && rejected) {
      const reason = protocol.bodyCode === 'agent_connection_unavailable' ? 'agent_connection_unavailable' : 'revoked';
      await commit(blankPairing(state.epoch + 1, 'revoked', reason));
      return;
    }
    await quarantine(protocol.code);
  }

  function validateChallenge(value: unknown, thumbprint: string): EnrollmentChallenge {
    const record = asRecord(value);
    check(exactKeys(record, {
      profile: literal('freedom.runtime-enrollment/v1'),
      purpose: literal('runtime_enrollment'),
      challenge_id: isUuid,
      owner_member_id: isUuid,
      owner_principal_id: isUuid,
      scope_id: isUuid,
      runtime_device_id: isUuid,
      environment: literal(profile.environment),
      key_thumbprint: literal(thumbprint),
      nonce: isBytes32,
      issued_at: isIsoTime,
      expires_at: isIsoTime,
      operational_authority: noAuthority,
      payload: (item) => typeof item === 'string' && encoder.encode(item).byteLength <= 2048,
    }));
    const expected = {
      profile: record.profile,
      purpose: record.purpose,
      challenge_id: record.challenge_id,
      owner_member_id: record.owner_member_id,
      owner_principal_id: record.owner_principal_id,
      scope_id: record.scope_id,
      runtime_device_id: record.runtime_device_id,
      environment: record.environment,
      key_thumbprint: record.key_thumbprint,
      nonce: record.nonce,
      issued_at: record.issued_at,
      expires_at: record.expires_at,
      operational_authority: false,
    };
    check(record.payload === JSON.stringify(expected));
    check(Date.parse(record.expires_at as string) - Date.parse(record.issued_at as string) === 300_000);
    check(Date.parse(record.expires_at as string) > clock.now());
    return record as unknown as EnrollmentChallenge;
  }

  async function begin(): Promise<PublicView> {
    return exclusive(async () => {
      if (state.phase === 'waiting' || state.phase === 'connected' || state.phase === 'beginning') {
        throw new ProtocolError('already_started');
      }
      if (state.phase !== 'disconnected') await commit(blankPairing(state.epoch + 1, 'disconnected', null));
      device = await keys.create();
      await commit({ ...blankPairing(state.epoch + 1, 'beginning', null) });
      try {
        const proof = await postProof('begin', 'freedom-device-pairing+jwt', {
          ...claims('device_pairing_begin', 'begin'),
          runtime_kind: 'extension',
          scope: 'bootstrap.status.read',
        });
        const value = asRecord(await call('begin', 'POST', { publicJwk: device.jwk, runtimeKind: 'extension' }, { DPoP: proof }, 201));
        check(exactKeys(value, {
          authorizationId: isUuid,
          deviceCode: isBytes32,
          userCode: (item) => typeof item === 'string' && userCodePattern.test(item),
          nonce: isBytes32,
          requestDigest: isBytes32,
          verificationUri: (item) => verificationUriOk(item, profile.origin),
          issuedAt: isIsoTime,
          expiresAt: isIsoTime,
          expiresIn: literal(300),
          interval: literal(5),
          operational_authority: noAuthority,
        }));
        check(Date.parse(value.expiresAt as string) - Date.parse(value.issuedAt as string) === 300_000);
        check(Date.parse(value.expiresAt as string) > clock.now());
        const next = blankPairing(state.epoch + 1, 'waiting', null);
        next.authorizationId = value.authorizationId as string;
        next.deviceCode = value.deviceCode as string;
        next.userCode = value.userCode as string;
        next.nonce = value.nonce as string;
        next.requestDigest = value.requestDigest as string;
        next.verificationUri = value.verificationUri as string;
        next.expiresAt = value.expiresAt as string;
        next.intervalSeconds = 5;
        next.nextPollAt = clock.now();
        await commit(next);
      } catch (error) {
        if (error instanceof ProtocolError && (error.code === 'already_started' || error.code === 'operation_in_progress')) throw error;
        await failCall('begin', error);
      }
    });
  }

  async function poll(): Promise<PublicView> {
    return exclusive(async () => {
      if (state.phase !== 'waiting' || !device) return;
      if (!state.expiresAt || !state.authorizationId || !state.deviceCode || !state.nonce || !state.requestDigest) {
        await quarantine('pairing_state_invalid');
        return;
      }
      if (clock.now() >= Date.parse(state.expiresAt)) {
        await commit(blankPairing(state.epoch + 1, 'expired', 'expired_token'));
        return;
      }
      if (state.nextPollAt !== null && clock.now() < state.nextPollAt) return;
      const current = device;
      try {
        const proof = await postProof('token', 'freedom-device-pairing+jwt', {
          ...claims('device_pairing_poll', 'token'),
          runtime_kind: 'extension',
          scope: 'bootstrap.status.read',
          authorization_id: state.authorizationId,
          nonce: state.nonce,
          request_digest: state.requestDigest,
          device_code_hash: await sha256b64(state.deviceCode),
        });
        let enrollmentProof: string | undefined;
        if (state.challenge) {
          enrollmentProof = await signCompact(current.privateKey, { alg: 'ES256', typ: 'freedom-runtime-enrollment+jws' }, state.challenge.payload);
          state = { ...state, enrollmentArmed: true };
          await store.write(state);
        }
        const value = asRecord(await call('token', 'POST', {
          grantType: 'device_code',
          authorizationId: state.authorizationId,
          deviceCode: state.deviceCode,
          ...(enrollmentProof ? { enrollmentProof } : {}),
        }, { DPoP: proof }, 200));
        const status = value.status;
        if (status === 'issued') {
          check(Boolean(enrollmentProof));
          await acceptIssued(value, state.challenge);
          return;
        }
        check(!enrollmentProof);
        if (status === 'authorization_pending' || status === 'slow_down') {
          check(exactKeys(value, { status: literal(status), interval: intervalOk, operational_authority: noAuthority }));
          state = {
            ...state,
            intervalSeconds: value.interval as number,
            nextPollAt: clock.now() + (value.interval as number) * 1000,
            enrollmentArmed: false,
          };
          await store.write(state);
          return;
        }
        if (status === 'proof_required') {
          check(exactKeys(value, {
            status: literal('proof_required'),
            challenge: (item) => item !== null && typeof item === 'object',
            interval: intervalOk,
            operational_authority: noAuthority,
          }));
          const challenge = validateChallenge(value.challenge, current.thumbprint);
          state = {
            ...state,
            challenge,
            intervalSeconds: value.interval as number,
            nextPollAt: clock.now() + (value.interval as number) * 1000,
            enrollmentArmed: false,
          };
          await store.write(state);
          return;
        }
        if (status === 'access_denied' || status === 'expired_token') {
          check(exactKeys(value, { status: literal(status), operational_authority: noAuthority }));
          const phase = status === 'expired_token' ? 'expired' : 'reconnect';
          const reason = status === 'expired_token' ? 'expired_token' : 'denied';
          await commit(blankPairing(state.epoch + 1, phase, reason));
          return;
        }
        throw new ProtocolError('response_invalid');
      } catch (error) {
        if (state.phase === 'waiting' || state.phase === 'beginning') await failCall('poll', error);
      }
    });
  }

  async function acceptIssued(value: Record<string, unknown>, challenge: EnrollmentChallenge | null): Promise<void> {
    check(challenge !== null);
    const refreshOk = (item: unknown) => exactKeys(item, {
      familyId: isUuid,
      generation: isVersion,
      handle: isBytes32,
      expiresAt: isIsoTime,
    });
    const nonceOk = (item: unknown) => {
      if (!exactKeys(item, {
        nonceId: isUuid,
        nonce: isBytes32,
        connectionId: isUuid,
        issuedAt: isIsoTime,
        expiresAt: isIsoTime,
        operational_authority: noAuthority,
      })) return false;
      const nonce = item as { issuedAt: string; expiresAt: string };
      return Date.parse(nonce.expiresAt) > Date.parse(nonce.issuedAt) && Date.parse(nonce.expiresAt) - Date.parse(nonce.issuedAt) <= 60_000;
    };
    check(exactKeys(value, {
      status: literal('issued'),
      accessToken: (item) => typeof item === 'string' && item.length <= 8192 && compactPattern.test(item),
      tokenType: literal('DPoP'),
      expiresAt: isIsoTime,
      connectionId: isUuid,
      runtimeDeviceId: isUuid,
      nonce: nonceOk,
      refreshSupported: literal(true),
      refresh: refreshOk,
      operational_authority: noAuthority,
    }));
    const refresh = value.refresh as PersistedPairing['refresh'];
    check(refresh !== null && refresh.generation === '1');
    check(value.runtimeDeviceId === challenge.runtime_device_id);
    const nonce = value.nonce as { connectionId: string };
    check(nonce.connectionId === value.connectionId);
    check(Date.parse(value.expiresAt as string) > clock.now());
    check(Date.parse(refresh.expiresAt) >= Date.parse(value.expiresAt as string));
    const next = blankPairing(state.epoch + 1, 'connected', null);
    next.accessToken = value.accessToken as string;
    next.tokenExpiresAt = value.expiresAt as string;
    next.connectionId = value.connectionId as string;
    next.runtimeDeviceId = value.runtimeDeviceId as string;
    next.refresh = refresh;
    next.lastStatusAt = clock.now();
    await commit(next);
  }

  async function rotate(): Promise<void> {
    if (state.phase !== 'connected' || !state.refresh || !state.connectionId || !state.accessToken || !device) {
      throw new ProtocolError('session_required');
    }
    const previous = state;
    const proof = await postProof('token', 'freedom-bootstrap-refresh+jwt', {
      ...claims('bootstrap_refresh', 'token'),
      connection_id: previous.connectionId,
      family_id: previous.refresh!.familyId,
      generation: previous.refresh!.generation,
      refresh_handle_hash: await sha256b64(previous.refresh!.handle),
    });
    state = { ...state, refreshArmed: true };
    await store.write(state);
    const value = asRecord(await call('token', 'POST', {
      grantType: 'refresh_token',
      familyId: previous.refresh!.familyId,
      refreshHandle: previous.refresh!.handle,
    }, { DPoP: proof }, 200));
    const refreshOk = (item: unknown) => exactKeys(item, {
      familyId: isUuid,
      generation: isVersion,
      handle: isBytes32,
      expiresAt: isIsoTime,
    });
    check(exactKeys(value, {
      accessToken: (item) => typeof item === 'string' && item.length <= 8192 && compactPattern.test(item),
      tokenType: literal('DPoP'),
      expiresAt: isIsoTime,
      connectionId: isUuid,
      runtimeDeviceId: isUuid,
      refresh: refreshOk,
      operational_authority: noAuthority,
    }));
    const refresh = value.refresh as NonNullable<PersistedPairing['refresh']>;
    check(value.connectionId === previous.connectionId && value.runtimeDeviceId === previous.runtimeDeviceId);
    check(refresh.familyId === previous.refresh!.familyId);
    check(BigInt(refresh.generation) === BigInt(previous.refresh!.generation) + 1n);
    check(refresh.handle !== previous.refresh!.handle);
    check(refresh.expiresAt === previous.refresh!.expiresAt);
    check(Date.parse(value.expiresAt as string) > clock.now());
    check(Date.parse(value.expiresAt as string) <= Date.parse(refresh.expiresAt));
    const next = blankPairing(previous.epoch, 'connected', null);
    next.epoch = previous.epoch;
    next.accessToken = value.accessToken as string;
    next.tokenExpiresAt = value.expiresAt as string;
    next.connectionId = previous.connectionId;
    next.runtimeDeviceId = previous.runtimeDeviceId;
    next.refresh = refresh;
    next.lastStatusAt = clock.now();
    await commit(next);
  }

  async function refresh(): Promise<PublicView> {
    return exclusive(async () => {
      if (state.phase !== 'connected') return;
      try {
        await rotate();
      } catch (error) {
        await failCall('refresh', error);
      }
    });
  }

  async function readStatus(): Promise<PublicView> {
    return exclusive(async () => {
      if (state.phase !== 'connected' || !device || !state.accessToken || !state.connectionId) return;
      try {
        if (state.tokenExpiresAt && Date.parse(state.tokenExpiresAt) - clock.now() < 30_000) await rotate();
        if (state.phase !== 'connected' || !state.accessToken || !state.connectionId) return;
        const authorization = `DPoP ${state.accessToken}`;
        const ath = await sha256b64(state.accessToken);
        const nonceProof = await postProof('nonce', 'freedom-bootstrap-nonce+jwt', {
          ...claims('bootstrap_nonce', 'nonce'),
          connection_id: state.connectionId,
          ath,
        });
        const nonceValue = asRecord(await call('nonce', 'POST', { connectionId: state.connectionId }, {
          Authorization: authorization,
          DPoP: nonceProof,
        }, 201));
        check(exactKeys(nonceValue, {
          nonceId: isUuid,
          nonce: isBytes32,
          connectionId: literal(state.connectionId),
          issuedAt: isIsoTime,
          expiresAt: isIsoTime,
          operational_authority: noAuthority,
        }));
        const nonce = nonceValue as { nonceId: string; nonce: string; issuedAt: string; expiresAt: string };
        check(Date.parse(nonce.expiresAt) > Date.parse(nonce.issuedAt) && Date.parse(nonce.expiresAt) > clock.now());
        const proof = await postProof('status', 'dpop+jwt', {
          jti: randomJti(),
          iat: Math.floor(clock.now() / 1000),
          htm: 'GET',
          htu: profile.origin + PATHS.status,
          ath,
          nonce: nonce.nonce,
        });
        const status = asRecord(await call('status', 'GET', undefined, {
          Authorization: authorization,
          DPoP: proof,
          'X-Freedom-Connection': state.connectionId,
          'X-Freedom-Nonce': nonce.nonceId,
        }, 200));
        check(exactKeys(status, {
          connectionId: literal(state.connectionId),
          runtimeDeviceId: literal(state.runtimeDeviceId),
          clientId: literal(profile.clientId),
          environment: literal(profile.environment),
          connectionVersion: isVersion,
          expiresAt: isIsoTime,
          state: literal('active'),
          operation: literal('bootstrap.status.read'),
          operational_authority: noAuthority,
        }));
        state = { ...state, lastStatusAt: clock.now() };
        await store.write(state);
      } catch (error) {
        await failCall('status', error);
      }
    });
  }

  async function disconnect(): Promise<PublicView> {
    return exclusive(async () => {
      if (state.phase === 'disconnected' && !state.accessToken && !state.deviceCode && !state.refresh) {
        device = null;
        await keys.destroy();
        return;
      }
      await commit(blankPairing(state.epoch + 1, 'disconnected', null));
    });
  }

  return {
    begin,
    poll,
    refresh,
    readStatus,
    disconnect,
    view,
    verificationUri: () => (state.phase === 'waiting' ? state.verificationUri : null),
    shouldRecheck(intervalMs: number) {
      return state.phase === 'connected' && clock.now() - (state.lastStatusAt ?? 0) >= intervalMs;
    },
  };
}

function intervalOk(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 325;
}

function normalize(value: PersistedPairing | null): PersistedPairing {
  if (!value || value.v !== 1 || typeof value.epoch !== 'number') return blankPairing(1, 'disconnected', null);
  return value;
}

export type { PublicJwk, RuntimeEnvironment };
