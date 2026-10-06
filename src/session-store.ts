import type { PersistedPairing } from './pairing-state.ts';

const KEY = 'freedom.pairing';

export interface SessionStore {
  read(): Promise<PersistedPairing | null>;
  write(value: PersistedPairing): Promise<void>;
  clear(): Promise<void>;
}

const TOKEN_LIKE = /accessToken|refreshHandle|deviceCode|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;

/** Session storage may hold bootstrap tokens. local and sync may not. */
export function assertCredentialArea(area: string, value: unknown): void {
  if (area === 'session') return;
  const text = JSON.stringify(value) ?? '';
  if (TOKEN_LIKE.test(text)) throw new Error('credential_storage_rejected');
}

interface StorageArea {
  get: (keys: string[]) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
}

export function createChromeSessionStore(area: StorageArea): SessionStore {
  return {
    async read() {
      const got = await area.get([KEY]);
      const value = got[KEY];
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      return value as PersistedPairing;
    },
    async write(value) {
      assertCredentialArea('session', value);
      await area.set({ [KEY]: value });
    },
    async clear() {
      await area.remove([KEY]);
    },
  };
}

export function createMemorySessionStore(): SessionStore & { raw(): PersistedPairing | null } {
  let current: PersistedPairing | null = null;
  return {
    async read() {
      return current ? structuredClone(current) : null;
    },
    async write(value) {
      assertCredentialArea('session', value);
      current = structuredClone(value);
    },
    async clear() {
      current = null;
    },
    raw() {
      return current ? structuredClone(current) : null;
    },
  };
}
