import { A2_RESERVED_TYPES } from './extension-points/a2.ts';
import { siteOrigin } from './origin.ts';

const MAX_BYTES = 4096;
const encoder = new TextEncoder();
const forbiddenText = /eval\s*\(|new\s+Function|function\s*\(|<script|javascript:|data:|import\s*\(|https?:\/\//i;

export interface MessageSender {
  id?: string;
  url?: string;
  origin?: string;
  frameId?: number;
  documentId?: string;
  tab?: { id?: number; url?: string } | undefined;
}

export interface RouteResult {
  ok: boolean;
  error?: string;
  snapshot?: ExtensionSnapshot;
  /** Present when a content script bind succeeded. */
  boundEpoch?: number;
}

export interface ExtensionSnapshot {
  phase: string;
  reason: string | null;
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: string | null;
  connectionId: string | null;
  epoch: number;
  pollAfterMs: number;
  modes: { extension_byok: 'available'; extension_cli: 'available' | 'missing' };
  sites: Array<{ origin: string; tabId: number | null; state: string; message: string | null }>;
}

const extensionTypes = new Set([
  'pairing.snapshot',
  'pairing.begin',
  'pairing.openVerification',
  'pairing.disconnect',
  'modes.snapshot',
  'site.list',
  'site.start',
  'site.removePermission',
]);

const contentTypes = new Set(['site.hello', 'site.ping']);

const keySets: Record<string, string[]> = {
  'pairing.snapshot': ['epoch', 'type'],
  'pairing.begin': ['epoch', 'type'],
  'pairing.openVerification': ['epoch', 'type'],
  'pairing.disconnect': ['epoch', 'type'],
  'modes.snapshot': ['epoch', 'type'],
  'site.list': ['epoch', 'type'],
  'site.start': ['epoch', 'origin', 'tabId', 'type'],
  'site.removePermission': ['epoch', 'origin', 'type'],
  'site.hello': ['type'],
  'site.ping': ['epoch', 'type'],
};

export interface RouterDeps {
  runtimeId: string;
  platformOrigin: string;
  pairingEpoch(): number;
  snapshot(): Promise<ExtensionSnapshot>;
  begin(): Promise<ExtensionSnapshot>;
  disconnect(): Promise<ExtensionSnapshot>;
  openVerification(): Promise<ExtensionSnapshot>;
  modes(): Promise<ExtensionSnapshot>;
  startSite(origin: string, tabId: number): Promise<ExtensionSnapshot>;
  removeSite(origin: string): Promise<ExtensionSnapshot>;
  hello(sender: MessageSender): Promise<RouteResult>;
  ping(sender: MessageSender, epoch: number): Promise<RouteResult>;
}

function reject(error: string): RouteResult {
  return { ok: false, error };
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 2 ** 53;
}

function jsonData(value: unknown, depth: number): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_BYTES;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.entries(value as Record<string, unknown>).every(([key, item]) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
    return jsonData(item, depth + 1);
  });
}

function stringsAllowed(value: unknown, platformOrigin: string): boolean {
  if (typeof value === 'string') return !forbiddenText.test(value);
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value as Record<string, unknown>).every(([key, item]) => {
    if (typeof item === 'string' && key === 'origin') {
      return siteOrigin(item, platformOrigin) !== null && !/eval\s*\(|new\s+Function|javascript:|data:|import\s*\(|<script/i.test(item);
    }
    return stringsAllowed(item, platformOrigin);
  });
}

function isExtensionUrl(value: string | undefined, runtimeId: string): boolean {
  return typeof value === 'string' && value.startsWith(`chrome-extension://${runtimeId}/`);
}

/** Chrome sets sender.url. An extension page opened in a tab still has tab.id,
 * and without the tabs permission tab.url is omitted. A content script cannot
 * present this extension's URL while its tab URL is a website. */
export function classifySender(sender: MessageSender, runtimeId: string): 'extension' | 'content' | 'rejected' {
  if (sender.id !== runtimeId) return 'rejected';
  const extensionPage = isExtensionUrl(sender.url, runtimeId);
  const tabUrl = sender.tab?.url;
  if (extensionPage && (sender.tab == null || tabUrl == null || isExtensionUrl(tabUrl, runtimeId))) return 'extension';
  if (sender.tab != null && typeof sender.tab.id === 'number' && !extensionPage) return 'content';
  return 'rejected';
}

export function createRouter(deps: RouterDeps) {
  return {
    async handle(message: unknown, sender: MessageSender): Promise<RouteResult> {
      let encoded = '';
      try {
        encoded = JSON.stringify(message);
      } catch {
        return reject('schema');
      }
      if (!encoded || encoder.encode(encoded).byteLength > MAX_BYTES) return reject('oversize');
      if (!jsonData(message, 0)) return reject('schema');
      const record = message as Record<string, unknown>;
      if (typeof record.type !== 'string') return reject('schema');
      if ((A2_RESERVED_TYPES as readonly string[]).includes(record.type)) return reject('schema');
      const expected = keySets[record.type];
      if (!expected) return reject('schema');
      const keys = Object.keys(record).sort();
      if (keys.join(',') !== [...expected].sort().join(',')) return reject('schema');
      if (!stringsAllowed(record, deps.platformOrigin)) return reject('schema');
      const context = classifySender(sender, deps.runtimeId);
      if (context === 'rejected') return reject('sender');
      if (context === 'content' && !contentTypes.has(record.type)) return reject('context');
      if (context === 'extension' && !extensionTypes.has(record.type)) return reject('context');
      if (record.type !== 'site.hello') {
        if (!isInteger(record.epoch)) return reject('schema');
        const epoch = record.epoch as number;
        if (context === 'extension' && record.type !== 'pairing.snapshot' && epoch !== deps.pairingEpoch()) return reject('stale_epoch');
        if (context === 'extension' && record.type !== 'pairing.snapshot' && epoch === 0) return reject('stale_epoch');
        if (record.type === 'pairing.snapshot' && epoch !== 0 && epoch !== deps.pairingEpoch()) return reject('stale_epoch');
      }
      try {
        switch (record.type) {
          case 'pairing.snapshot':
          case 'site.list':
            return { ok: true, snapshot: await deps.snapshot() };
          case 'pairing.begin':
            return { ok: true, snapshot: await deps.begin() };
          case 'pairing.disconnect':
            return { ok: true, snapshot: await deps.disconnect() };
          case 'pairing.openVerification':
            return { ok: true, snapshot: await deps.openVerification() };
          case 'modes.snapshot':
            return { ok: true, snapshot: await deps.modes() };
          case 'site.start': {
            if (typeof record.origin !== 'string' || !isInteger(record.tabId)) return reject('schema');
            const origin = siteOrigin(record.origin, deps.platformOrigin);
            if (!origin) return reject('schema');
            return { ok: true, snapshot: await deps.startSite(origin, record.tabId) };
          }
          case 'site.removePermission': {
            if (typeof record.origin !== 'string') return reject('schema');
            const origin = siteOrigin(record.origin, deps.platformOrigin);
            if (!origin) return reject('schema');
            return { ok: true, snapshot: await deps.removeSite(origin) };
          }
          case 'site.hello':
            return deps.hello(sender);
          case 'site.ping':
            return deps.ping(sender, record.epoch as number);
          default:
            return reject('schema');
        }
      } catch {
        return reject('rejected');
      }
    },
  };
}
