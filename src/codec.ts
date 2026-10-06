const encoder = new TextEncoder();

export const bytes32Pattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const compactPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const userCodePattern = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

export class ProtocolError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly bodyCode: string | undefined;
  constructor(code: string, status?: number, bodyCode?: string) {
    super(code);
    this.name = 'ProtocolError';
    this.code = code;
    this.status = status;
    this.bodyCode = bodyCode;
  }
}

export function fail(code: string, status?: number, bodyCode?: string): never {
  throw new ProtocolError(code, status, bodyCode);
}

export function check(condition: unknown, code = 'response_invalid'): asserts condition {
  if (!condition) fail(code);
}

export function b64(bytes: BufferSource): string {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = '';
  for (let index = 0; index < view.length; index += 1) binary += String.fromCharCode(view[index]);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function b64decode(value: string): Uint8Array {
  const padded = value.length % 4 === 0 ? value : value + '='.repeat(4 - (value.length % 4));
  const binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

export function encodePart(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return b64(encoder.encode(text));
}

export async function sha256b64(value: string): Promise<string> {
  return b64(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export function randomJti(): string {
  return b64(crypto.getRandomValues(new Uint8Array(24)));
}

export function randomBytes32(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export async function publicJwk(key: CryptoKey): Promise<PublicJwk> {
  const exported = await crypto.subtle.exportKey('jwk', key);
  if (exported.kty !== 'EC' || exported.crv !== 'P-256' || typeof exported.x !== 'string' || typeof exported.y !== 'string') {
    fail('public_jwk_invalid');
  }
  if (!bytes32Pattern.test(exported.x) || !bytes32Pattern.test(exported.y)) fail('public_jwk_invalid');
  return { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y };
}

export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  return sha256b64(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

export async function signCompact(privateKey: CryptoKey, header: object, payload: object | string): Promise<string> {
  const data = encodePart(header) + '.' + encodePart(payload);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, encoder.encode(data));
  return data + '.' + b64(signature);
}

export function isIsoTime(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

export function isBytes32(value: unknown): value is string {
  return typeof value === 'string' && bytes32Pattern.test(value);
}

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

export function exactKeys(value: unknown, fields: Record<string, (item: unknown) => boolean>): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expected = Object.keys(fields);
  if (keys.length !== expected.length) return false;
  return expected.every((key) => Object.hasOwn(record, key) && fields[key](record[key]));
}
