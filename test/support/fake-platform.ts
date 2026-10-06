import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { b64, b64decode, type PublicJwk, sha256b64 } from '../../src/codec.ts';
import { PATHS } from '../../src/paths.ts';
import type { TestClock } from './clock.ts';

export interface ProofExpectation {
  htm: string;
  htu: string;
  nonce?: string;
  ath?: string;
  accessToken?: string;
}

interface AssessOk {
  ok: true;
  claims: Record<string, unknown>;
  header: { jwk?: PublicJwk };
}

interface AssessNo {
  ok: false;
  reason: string;
}

interface AuthRecord {
  authorizationId: string;
  deviceCode: string;
  userCode: string;
  nonce: string;
  requestDigest: string;
  verificationUri: string;
  issuedAt: string;
  expiresAt: string;
  publicJwk: PublicJwk;
  thumbprint: string;
  decision: 'pending' | 'approved' | 'denied' | 'expired';
  interval: number;
  nextPollAt: number;
  challengePayload: string | null;
  challenge: Record<string, unknown> | null;
}

interface ConnectionRecord {
  id: string;
  version: string;
  runtimeDeviceId: string;
  accessToken: string;
  accessExpiresAt: string;
  refresh: { familyId: string; generation: string; handle: string; expiresAt: string };
  revoked: boolean;
  consumed: Set<string>;
}

interface HttpResult {
  status: number;
  body: string;
  contentType: string;
}

function problem(status: number, code: string): HttpResult {
  return { status, body: JSON.stringify({ code }), contentType: 'application/problem+json' };
}

function ok(status: number, value: unknown): HttpResult {
  return { status, body: JSON.stringify(value), contentType: 'application/json' };
}

function bytes32(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

function userCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = '';
  for (let index = 0; index < 10; index += 1) {
    out += alphabet[bytes[index] % 32];
    if (index === 4) out += '-';
  }
  return out;
}

function compactToken(): string {
  return `${bytes32()}.${bytes32()}.${bytes32()}`;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? headers[found] : undefined;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function createFakePlatform(options: {
  clock: TestClock;
  origin: string;
  clientId: string;
  environment: string;
}) {
  const { clock, origin, clientId, environment } = options;
  const usedJti = new Set<string>();
  const byUser = new Map<string, AuthRecord>();
  const byDevice = new Map<string, AuthRecord>();
  const connections = new Map<string, ConnectionRecord>();
  const rejections: Array<{ reason: string }> = [];
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  const verified = { signature: 0, htm: 0, htu: 0, jti: 0, nonce: 0, ath: 0 };
  const counts = { begin: 0, token: 0, nonce: 0, status: 0 };
  let failNext: 'redirect' | 'redirect-status' | 'malformed' | 'oversize' | 'abort' | 'lost' | null = null;
  let forceSlowDown = false;
  const encoder = new TextEncoder();

  function reject(reason: string): AssessNo {
    rejections.push({ reason });
    return { ok: false, reason };
  }

  async function assess(proof: string, expected: ProofExpectation): Promise<AssessOk | AssessNo> {
    const parts = proof.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return reject('signature');
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(new TextDecoder().decode(b64decode(parts[0]))) as Record<string, unknown>;
      claims = JSON.parse(new TextDecoder().decode(b64decode(parts[1]))) as Record<string, unknown>;
    } catch {
      return reject('signature');
    }
    const jwk = header.jwk as Partial<PublicJwk> | undefined;
    if (header.alg !== 'ES256' || !jwk) return reject('signature');
    let signed = false;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      signed = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64decode(parts[2]) as BufferSource, encoder.encode(`${parts[0]}.${parts[1]}`));
    } catch {
      signed = false;
    }
    if (!signed) return reject('signature');
    verified.signature += 1;
    if (claims.htm !== expected.htm) return reject('htm');
    verified.htm += 1;
    if (claims.htu !== expected.htu) return reject('htu');
    verified.htu += 1;
    if (typeof claims.iat !== 'number' || !Number.isInteger(claims.iat)) return reject('window');
    const validFrom = (claims.iat - 5) * 1000;
    const validUntil = (claims.iat + 61) * 1000;
    if (clock.now() < validFrom || clock.now() >= validUntil) return reject('window');
    if (expected.nonce !== undefined) {
      if (claims.nonce !== expected.nonce) return reject('nonce');
      verified.nonce += 1;
    }
    if (expected.ath !== undefined) {
      const actual = expected.accessToken === undefined ? expected.ath : await sha256b64(expected.accessToken);
      if (claims.ath !== expected.ath || claims.ath !== actual) return reject('ath');
      verified.ath += 1;
    }
    if (typeof claims.jti !== 'string' || claims.jti.length < 16 || usedJti.has(claims.jti)) return reject('jti');
    usedJti.add(claims.jti);
    verified.jti += 1;
    return { ok: true, claims, header: header as { jwk?: PublicJwk } };
  }

  async function verifyEnrollment(proof: string, jwk: PublicJwk, payload: string): Promise<boolean> {
    const parts = proof.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return false;
    const headerJson = new TextDecoder().decode(b64decode(parts[0]));
    const body = new TextDecoder().decode(b64decode(parts[1]));
    if (headerJson !== '{"alg":"ES256","typ":"freedom-runtime-enrollment+jws"}' || body !== payload) return false;
    try {
      const key = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64decode(parts[2]) as BufferSource, encoder.encode(`${parts[0]}.${parts[1]}`));
    } catch {
      return false;
    }
  }

  const issuedNonces = new Map<string, { nonce: string; connectionId: string; used: boolean }>();

  function latestConnection(): ConnectionRecord | null {
    const all = [...connections.values()];
    return all.length === 0 ? null : all[all.length - 1];
  }

  async function issue(auth: AuthRecord): Promise<HttpResult> {
    const now = clock.now();
    const connectionId = crypto.randomUUID();
    const runtimeDeviceId = (auth.challenge?.runtime_device_id as string) ?? crypto.randomUUID();
    const accessExpiresAt = iso(now + 10 * 60_000);
    const refreshExpiresAt = iso(now + 30 * 24 * 60 * 60_000);
    const connection: ConnectionRecord = {
      id: connectionId,
      version: '1',
      runtimeDeviceId,
      accessToken: compactToken(),
      accessExpiresAt,
      refresh: { familyId: crypto.randomUUID(), generation: '1', handle: bytes32(), expiresAt: refreshExpiresAt },
      revoked: false,
      consumed: new Set(),
    };
    connections.set(connectionId, connection);
    const nonceIssued = iso(now);
    return ok(200, {
      status: 'issued',
      accessToken: connection.accessToken,
      tokenType: 'DPoP',
      expiresAt: accessExpiresAt,
      connectionId,
      runtimeDeviceId,
      nonce: {
        nonceId: crypto.randomUUID(),
        nonce: bytes32(),
        connectionId,
        issuedAt: nonceIssued,
        expiresAt: iso(now + 60_000),
        operational_authority: false,
      },
      refreshSupported: true,
      refresh: connection.refresh,
      operational_authority: false,
    });
  }

  async function handle(method: string, url: string, headers: Record<string, string>, body: unknown): Promise<HttpResult> {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    requests.push({ method, url, headers, body });
    if (pathname === '/api/v1/me/device-authorizations/inspect' && method === 'POST') {
      const user = (body as { userCode?: string } | null)?.userCode;
      const auth = user ? byUser.get(user) : undefined;
      if (!auth) return problem(404, 'not_found');
      return ok(200, {
        authorizationId: auth.authorizationId,
        userCode: auth.userCode,
        requestDigest: auth.requestDigest,
        verificationUri: auth.verificationUri,
        status: auth.decision,
      });
    }
    if (pathname === '/api/v1/me/device-authorizations/decide' && method === 'POST') {
      if (!headerValue(headers, 'Idempotency-Key')) return problem(400, 'idempotency_required');
      const record = body as { userCode?: string; authorizationId?: string; requestDigest?: string; decision?: string };
      const auth = record.userCode ? byUser.get(record.userCode) : undefined;
      if (!auth || auth.authorizationId !== record.authorizationId || auth.requestDigest !== record.requestDigest) return problem(404, 'not_found');
      if (record.decision !== 'approve' && record.decision !== 'deny') return problem(400, 'decision_invalid');
      auth.decision = record.decision === 'approve' ? 'approved' : 'denied';
      return ok(200, { decision: record.decision });
    }
    if (pathname === '/api/v1/me/agent-connections' && method === 'GET') {
      return ok(200, {
        connections: [...connections.values()].map((connection) => ({
          connectionId: connection.id,
          version: connection.version,
          state: connection.revoked ? 'revoked' : 'active',
        })),
      });
    }
    const revokePrefix = '/api/v1/me/agent-connections/';
    if (method === 'POST' && pathname.startsWith(revokePrefix) && pathname.endsWith(':revoke')) {
      if (!headerValue(headers, 'Idempotency-Key')) return problem(400, 'idempotency_required');
      const match = headerValue(headers, 'If-Match');
      if (match !== '1' && match !== '"1"') return problem(412, 'precondition_failed');
      const id = decodeURIComponent(pathname.slice(revokePrefix.length, -':revoke'.length));
      const connection = connections.get(id);
      if (!connection) return problem(404, 'not_found');
      connection.revoked = true;
      return ok(200, { connectionId: id, state: 'revoked' });
    }

    const dpop = headerValue(headers, 'DPoP');
    if (!dpop) return problem(401, 'invalid_dpop');
    if (pathname === PATHS.begin && method === 'POST') {
      counts.begin += 1;
      const checked = await assess(dpop, { htm: 'POST', htu: origin + PATHS.begin });
      if (!checked.ok) return problem(401, 'invalid_dpop');
      const input = body as { publicJwk?: PublicJwk; runtimeKind?: string };
      const jwk = checked.header.jwk;
      if (!input.publicJwk || input.runtimeKind !== 'extension' || !jwk || input.publicJwk.x !== jwk.x || input.publicJwk.y !== jwk.y) return problem(400, 'request_invalid');
      if (checked.claims.purpose !== 'device_pairing_begin' || checked.claims.runtime_kind !== 'extension' || checked.claims.client_id !== clientId || checked.claims.environment !== environment) {
        return problem(401, 'invalid_dpop');
      }
      const now = clock.now();
      const code = userCode();
      const auth: AuthRecord = {
        authorizationId: crypto.randomUUID(),
        deviceCode: bytes32(),
        userCode: code,
        nonce: bytes32(),
        requestDigest: bytes32(),
        verificationUri: `${origin}/device/${code}`,
        issuedAt: iso(now),
        expiresAt: iso(now + 300_000),
        publicJwk: { kty: 'EC', crv: 'P-256', x: input.publicJwk.x, y: input.publicJwk.y },
        thumbprint: await sha256b64(JSON.stringify({ crv: 'P-256', kty: 'EC', x: input.publicJwk.x, y: input.publicJwk.y })),
        decision: 'pending',
        interval: 5,
        nextPollAt: now,
        challengePayload: null,
        challenge: null,
      };
      byUser.set(code, auth);
      byDevice.set(auth.deviceCode, auth);
      return ok(201, {
        authorizationId: auth.authorizationId,
        deviceCode: auth.deviceCode,
        userCode: auth.userCode,
        nonce: auth.nonce,
        requestDigest: auth.requestDigest,
        verificationUri: auth.verificationUri,
        issuedAt: auth.issuedAt,
        expiresAt: auth.expiresAt,
        expiresIn: 300,
        interval: 5,
        operational_authority: false,
      });
    }
    if (pathname === PATHS.token && method === 'POST') {
      counts.token += 1;
      const input = body as { grantType?: string; authorizationId?: string; deviceCode?: string; enrollmentProof?: string; familyId?: string; refreshHandle?: string };
      if (input.grantType === 'refresh_token') {
        const connection = [...connections.values()].find((item) => item.refresh.familyId === input.familyId);
        if (!connection) return problem(401, 'bootstrap_invalid');
        const expectedHash = input.refreshHandle ? await sha256b64(input.refreshHandle) : '';
        const checked = await assess(dpop, { htm: 'POST', htu: origin + PATHS.token });
        if (!checked.ok) return problem(401, 'invalid_dpop');
        if (checked.claims.purpose !== 'bootstrap_refresh' || checked.claims.connection_id !== connection.id || checked.claims.refresh_handle_hash !== expectedHash) {
          return problem(401, 'invalid_dpop');
        }
        if (connection.revoked || !input.refreshHandle || connection.consumed.has(input.refreshHandle) || input.refreshHandle !== connection.refresh.handle) {
          connection.revoked = true;
          return problem(401, 'bootstrap_invalid');
        }
        connection.consumed.add(input.refreshHandle);
        const now = clock.now();
        connection.accessToken = compactToken();
        connection.accessExpiresAt = iso(now + 10 * 60_000);
        connection.refresh = {
          familyId: connection.refresh.familyId,
          generation: String(BigInt(connection.refresh.generation) + 1n),
          handle: bytes32(),
          expiresAt: connection.refresh.expiresAt,
        };
        return ok(200, {
          accessToken: connection.accessToken,
          tokenType: 'DPoP',
          expiresAt: connection.accessExpiresAt,
          connectionId: connection.id,
          runtimeDeviceId: connection.runtimeDeviceId,
          refresh: connection.refresh,
          operational_authority: false,
        });
      }
      const auth = input.deviceCode ? byDevice.get(input.deviceCode) : undefined;
      if (!auth || auth.authorizationId !== input.authorizationId) return problem(400, 'request_invalid');
      const checked = await assess(dpop, { htm: 'POST', htu: origin + PATHS.token, nonce: auth.nonce });
      if (!checked.ok) return problem(401, 'invalid_dpop');
      const codeHash = await sha256b64(auth.deviceCode);
      if (checked.claims.purpose !== 'device_pairing_poll' || checked.claims.authorization_id !== auth.authorizationId || checked.claims.device_code_hash !== codeHash || checked.claims.request_digest !== auth.requestDigest) {
        return problem(401, 'invalid_dpop');
      }
      if (clock.now() < auth.nextPollAt || forceSlowDown) {
        forceSlowDown = false;
        auth.interval = Math.min(325, auth.interval + 5);
        auth.nextPollAt = clock.now() + auth.interval * 1000;
        return ok(200, { status: 'slow_down', interval: auth.interval, operational_authority: false });
      }
      if (clock.now() >= Date.parse(auth.expiresAt) || auth.decision === 'expired') {
        return ok(200, { status: 'expired_token', operational_authority: false });
      }
      if (auth.decision === 'denied') return ok(200, { status: 'access_denied', operational_authority: false });
      if (auth.decision !== 'approved') {
        auth.nextPollAt = clock.now() + auth.interval * 1000;
        return ok(200, { status: 'authorization_pending', interval: auth.interval, operational_authority: false });
      }
      if (!auth.challenge || !auth.challengePayload) {
        const issuedAt = iso(clock.now());
        const expiresAt = iso(clock.now() + 300_000);
        const fields = {
          profile: 'freedom.runtime-enrollment/v1',
          purpose: 'runtime_enrollment',
          challenge_id: crypto.randomUUID(),
          owner_member_id: crypto.randomUUID(),
          owner_principal_id: crypto.randomUUID(),
          scope_id: crypto.randomUUID(),
          runtime_device_id: crypto.randomUUID(),
          environment,
          key_thumbprint: auth.thumbprint,
          nonce: bytes32(),
          issued_at: issuedAt,
          expires_at: expiresAt,
          operational_authority: false as const,
        };
        auth.challengePayload = JSON.stringify(fields);
        auth.challenge = { ...fields, payload: auth.challengePayload };
        auth.nextPollAt = clock.now() + auth.interval * 1000;
        return ok(200, { status: 'proof_required', challenge: auth.challenge, interval: auth.interval, operational_authority: false });
      }
      if (!input.enrollmentProof || !await verifyEnrollment(input.enrollmentProof, auth.publicJwk, auth.challengePayload)) return problem(401, 'invalid_dpop');
      return issue(auth);
    }
    if (pathname === PATHS.nonce && method === 'POST') {
      counts.nonce += 1;
      const authorization = headerValue(headers, 'Authorization') ?? '';
      const token = authorization.startsWith('DPoP ') ? authorization.slice(5) : '';
      const connection = [...connections.values()].find((item) => item.accessToken === token);
      if (!connection || connection.revoked) return problem(403, 'agent_connection_unavailable');
      const ath = await sha256b64(token);
      const checked = await assess(dpop, { htm: 'POST', htu: origin + PATHS.nonce, ath, accessToken: token });
      if (!checked.ok) return problem(401, 'invalid_dpop');
      const input = body as { connectionId?: string };
      if (input.connectionId !== connection.id || checked.claims.connection_id !== connection.id) return problem(401, 'invalid_dpop');
      const now = clock.now();
      const nonceId = crypto.randomUUID();
      const nonce = bytes32();
      issuedNonces.set(nonceId, { nonce, connectionId: connection.id, used: false });
      return ok(201, {
        nonceId,
        nonce,
        connectionId: connection.id,
        issuedAt: iso(now),
        expiresAt: iso(now + 60_000),
        operational_authority: false,
      });
    }
    if (pathname === PATHS.status && method === 'GET') {
      counts.status += 1;
      const authorization = headerValue(headers, 'Authorization') ?? '';
      const token = authorization.startsWith('DPoP ') ? authorization.slice(5) : '';
      const connection = [...connections.values()].find((item) => item.id === headerValue(headers, 'X-Freedom-Connection'));
      if (!connection || connection.revoked || connection.accessToken !== token) return problem(403, 'agent_connection_unavailable');
      const nonceId = headerValue(headers, 'X-Freedom-Nonce');
      const issued = nonceId ? issuedNonces.get(nonceId) : undefined;
      if (!issued || issued.used || issued.connectionId !== connection.id) return problem(401, 'invalid_dpop');
      const ath = await sha256b64(token);
      const checked = await assess(dpop, { htm: 'GET', htu: origin + PATHS.status, ath, accessToken: token, nonce: issued.nonce });
      if (!checked.ok) return problem(401, 'invalid_dpop');
      if (checked.claims.htm !== 'GET') return problem(401, 'invalid_dpop');
      issued.used = true;
      return ok(200, {
        connectionId: connection.id,
        runtimeDeviceId: connection.runtimeDeviceId,
        clientId,
        environment,
        connectionVersion: connection.version,
        expiresAt: connection.accessExpiresAt,
        state: 'active',
        operation: 'bootstrap.status.read',
        operational_authority: false,
      });
    }
    return problem(404, 'not_found');
  }

  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const mode = failNext;
    failNext = null;
    if (mode === 'redirect') throw new TypeError('redirect');
    if (mode === 'abort') throw new DOMException('The operation was aborted', 'AbortError');
    if (mode === 'lost') throw new TypeError('network unreachable');
    if (mode === 'redirect-status') {
      return new Response(null, { status: 302, headers: { Location: 'https://example.invalid/redirect', 'Content-Type': 'application/json' } });
    }
    if (mode === 'malformed') return new Response('{', { status: 201, headers: { 'Content-Type': 'application/json' } });
    if (mode === 'oversize') {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`{"pad":"${'a'.repeat(40_000)}"}`));
          controller.close();
        },
      });
      return new Response(stream, { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const parsedBody = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    const result = await handle(init?.method ?? 'GET', url, headers, parsedBody);
    return new Response(result.body, {
      status: result.status,
      headers: { 'Content-Type': result.contentType, 'Content-Length': String(Buffer.byteLength(result.body)) },
    });
  }

  async function listen(port = 4391): Promise<{ close(): Promise<void>; port: number }> {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void (async () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const body = raw ? JSON.parse(raw) as unknown : undefined;
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(request.headers)) {
              if (typeof value === 'string') headers[key] = value;
            }
            const result = await handle(request.method ?? 'GET', `http://127.0.0.1:${port}${request.url ?? '/'}`, headers, body);
            response.writeHead(result.status, {
              'Content-Type': result.contentType,
              'Content-Length': Buffer.byteLength(result.body),
              'Cache-Control': 'no-store',
            });
            response.end(result.body);
          } catch {
            const body = JSON.stringify({ code: 'server_error' });
            response.writeHead(500, { 'Content-Type': 'application/problem+json', 'Content-Length': Buffer.byteLength(body) });
            response.end(body);
          }
        })();
      });
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }

  return {
    fetchImpl: fetchImpl as typeof fetch,
    listen,
    assess,
    rejections,
    verified,
    counts,
    requests,
    get failNext() {
      return failNext;
    },
    set failNext(value: typeof failNext) {
      failNext = value;
    },
    set forceSlowDown(value: boolean) {
      forceSlowDown = value;
    },
    approve(code: string) {
      const auth = byUser.get(code);
      if (!auth) throw new Error('unknown_user_code');
      auth.decision = 'approved';
    },
    deny(code: string) {
      const auth = byUser.get(code);
      if (!auth) throw new Error('unknown_user_code');
      auth.decision = 'denied';
    },
    expire(code: string) {
      const auth = byUser.get(code);
      if (!auth) throw new Error('unknown_user_code');
      auth.decision = 'expired';
    },
    revoke(connectionId?: string) {
      const connection = connectionId ? connections.get(connectionId) : latestConnection();
      if (!connection) throw new Error('unknown_connection');
      connection.revoked = true;
    },
    consumeCurrentHandle() {
      const connection = latestConnection();
      if (!connection) throw new Error('unknown_connection');
      connection.consumed.add(connection.refresh.handle);
    },
  };
}
