import { ProtocolError, check, fail } from './codec.ts';
import { parseBoundedJson } from './json-bounds.ts';

const decoder = new TextDecoder('utf-8', { fatal: true });
const BODY_LIMIT = 32_768;

export interface ExchangeOptions {
  fetchImpl: typeof fetch;
  url: string;
  method: 'GET' | 'POST';
  body?: unknown;
  headers: Record<string, string>;
  expectedStatus: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** One bounded platform request. Redirects, cookies and oversized bodies are errors.
 * The caller decides whether an error quarantines or revokes; this function does not retry. */
export async function exchange(options: ExchangeOptions): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signals = options.signal ? [options.signal, deadline] : [deadline];
  const combined = AbortSignal.any(signals);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const onAbort = () => undefined;
  try {
    if (combined.aborted) fail('aborted');
    const headers = new Headers({ Accept: 'application/json', ...options.headers });
    if (options.method === 'POST') headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await options.fetchImpl(options.url, {
        method: options.method,
        headers,
        body: options.method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: combined,
      });
    } catch (error) {
      if (combined.aborted || (error instanceof Error && error.name === 'AbortError')) fail('aborted');
      const message = error instanceof Error ? error.message : '';
      if (/redirect/i.test(message)) fail('redirect');
      fail('transport_failed');
    }
    if (!(response instanceof Response)) fail('transport_failed');
    if (response.redirected || response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) {
      fail('redirect');
    }
    if (response.url && response.url !== options.url) fail('redirect');
    check(response.status >= 200 && response.status < 600);
    const type = response.headers.get('Content-Type') ?? '';
    check(/^application\/(?:problem\+)?json(?:\s*;\s*charset=utf-8)?$/i.test(type));
    const encoding = response.headers.get('Content-Encoding');
    const codings = encoding === null ? [] : encoding.toLowerCase().split(',').map((value) => value.trim());
    check(codings.length <= 3 && codings.every((value) => value === 'identity' || value === 'gzip' || value === 'deflate' || value === 'br'));
    const compressed = codings.some((value) => value !== 'identity');
    const declared = response.headers.get('Content-Length');
    check(declared === null || (/^\d+$/.test(declared) && Number.isSafeInteger(Number(declared)) && (compressed || Number(declared) <= BODY_LIMIT)));
    if (declared !== null && !compressed && Number(declared) > BODY_LIMIT) fail('oversize');
    check(response.body !== null);
    reader = response.body.getReader();
    let total = 0;
    let count = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      count += 1;
      if (total > BODY_LIMIT) fail('oversize');
      check(count <= 128);
      chunks.push(step.value);
    }
    check(compressed || declared === null || Number(declared) === total);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    check(!(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191));
    let value: unknown;
    try {
      value = parseBoundedJson(decoder.decode(bytes));
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      fail('response_invalid');
    }
    if (combined.aborted) fail('aborted');
    if (response.status !== options.expectedStatus) {
      const bodyCode = value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { code?: unknown }).code === 'string'
        ? (value as { code: string }).code
        : undefined;
      fail('http_rejected', response.status, bodyCode);
    }
    return value;
  } finally {
    combined.removeEventListener('abort', onAbort);
    if (reader) void reader.cancel().catch(() => undefined);
  }
}
