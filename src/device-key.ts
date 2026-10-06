import { type PublicJwk, jwkThumbprint, publicJwk } from './codec.ts';

const DB_NAME = 'freedom-browser-extension';
const STORE = 'device-key';
const RECORD = 'current';

export interface DeviceKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: PublicJwk;
  thumbprint: string;
}

interface StoredKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export interface DeviceKeyStore {
  load(): Promise<DeviceKey | null>;
  /** Replaces any previous key. The private key is generated nonextractable. */
  create(): Promise<DeviceKey>;
  destroy(): Promise<void>;
}

async function describe(stored: StoredKey): Promise<DeviceKey> {
  if (stored.privateKey.extractable) throw new Error('device_key_extractable');
  const jwk = await publicJwk(stored.publicKey);
  const thumbprint = await jwkThumbprint(jwk);
  return { privateKey: stored.privateKey, publicKey: stored.publicKey, jwk, thumbprint };
}

async function generate(): Promise<StoredKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  if (pair.privateKey.extractable) throw new Error('device_key_extractable');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

export function createMemoryKeyStore(): DeviceKeyStore {
  let current: StoredKey | null = null;
  return {
    async load() {
      return current ? describe(current) : null;
    },
    async create() {
      current = await generate();
      return describe(current);
    },
    async destroy() {
      current = null;
    },
  };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (request.readyState === 'done') {
      if (request.error) reject(request.error);
      else resolve(request.result);
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('idb_failed'));
  });
}

async function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
  };
  return requestToPromise(request);
}

/** Persists only the CryptoKey pair. Private export is never attempted. */
export function createIndexedDbKeyStore(factory: IDBFactory = globalThis.indexedDB): DeviceKeyStore {
  async function read(): Promise<StoredKey | null> {
    const database = await openDb(factory);
    try {
      const transaction = database.transaction(STORE, 'readonly');
      const stored = await requestToPromise(transaction.objectStore(STORE).get(RECORD));
      if (!stored || typeof stored !== 'object') return null;
      const record = stored as StoredKey;
      if (!record.privateKey || !record.publicKey) return null;
      return record;
    } finally {
      database.close();
    }
  }
  async function write(record: StoredKey | null): Promise<void> {
    const database = await openDb(factory);
    try {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      if (record === null) await requestToPromise(store.delete(RECORD));
      else await requestToPromise(store.put(record, RECORD));
    } finally {
      database.close();
    }
  }
  return {
    async load() {
      const stored = await read();
      return stored ? describe(stored) : null;
    },
    async create() {
      const record = await generate();
      await write(record);
      return describe(record);
    },
    async destroy() {
      await write(null);
    },
  };
}
