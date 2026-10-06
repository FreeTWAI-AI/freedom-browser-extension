import { assertCredentialArea } from '../../src/session-store.ts';
import type { ChromeBridge, ChromePort } from '../../src/background/runtime.ts';
import type { MessageSender } from '../../src/messages.ts';

interface Listener<T> {
  addListener(listener: T): void;
}

function events<T extends (...args: never[]) => void>(): Listener<T> & { emit(...args: Parameters<T>): void; listeners: T[] } {
  const listeners: T[] = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

function area(name: 'session' | 'local' | 'sync', counts: { localSet: number; syncSet: number }) {
  const values = new Map<string, unknown>();
  return {
    values,
    async get(keys: string[]) {
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (values.has(key)) result[key] = values.get(key);
      }
      return result;
    },
    async set(items: Record<string, unknown>) {
      if (name === 'local') counts.localSet += 1;
      if (name === 'sync') counts.syncSet += 1;
      assertCredentialArea(name, items);
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    },
    async remove(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) values.delete(key);
    },
  };
}

export function createFakeChrome(runtimeId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
  const counts = { localSet: 0, syncSet: 0, connectNative: 0, executeScript: 0 };
  const session = area('session', counts);
  const local = area('local', counts);
  const sync = area('sync', counts);
  const messages = events<(message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | void>();
  const connects = events<(port: ChromePort) => void>();
  const alarms = events<(alarm: { name: string }) => void>();
  const updated = events<(tabId: number, changeInfo: { url?: string }) => void>();
  const removed = events<(removed: { origins?: string[] }) => void>();
  const granted = { permissions: new Set<string>(), origins: new Set<string>() };
  const opened: string[] = [];
  const scripts: number[] = [];
  let nativeMode: 'throw' | 'drop' | 'stay' = 'throw';
  let alarmName = '';

  const chrome: ChromeBridge = {
    runtime: {
      id: runtimeId,
      onMessage: messages,
      onConnect: connects,
      connectNative() {
        counts.connectNative += 1;
        if (nativeMode === 'throw') throw new Error('native_missing');
        let notify: () => void = () => undefined;
        const port = {
          disconnect() {
            notify();
          },
          onDisconnect: {
            addListener(listener: () => void) {
              notify = listener;
              if (nativeMode === 'drop') listener();
            },
          },
        };
        return port;
      },
    },
    alarms: {
      create(name) {
        alarmName = name;
      },
      onAlarm: alarms,
    },
    tabs: {
      create(options) {
        opened.push(options.url);
        return { id: opened.length };
      },
      onUpdated: updated,
    },
    permissions: {
      async contains(permission) {
        const names = permission.permissions ?? [];
        const origins = permission.origins ?? [];
        return names.every((item) => granted.permissions.has(item)) && origins.every((item) => granted.origins.has(item));
      },
      async remove(permission) {
        for (const origin of permission.origins ?? []) granted.origins.delete(origin);
        removed.emit({ origins: permission.origins });
        return true;
      },
      onRemoved: removed,
    },
    scripting: {
      async executeScript(injection) {
        counts.executeScript += 1;
        scripts.push(injection.target.tabId);
      },
    },
  };

  return {
    chrome,
    counts,
    session,
    local,
    sync,
    opened,
    scripts,
    alarmName: () => alarmName,
    grantPermission(name: string) {
      granted.permissions.add(name);
    },
    grantOrigin(origin: string) {
      granted.origins.add(`${origin}/*`);
    },
    hasOrigin(origin: string) {
      return granted.origins.has(`${origin}/*`);
    },
    setNative(mode: 'throw' | 'drop' | 'stay') {
      nativeMode = mode;
    },
    emitUpdated(tabId: number, url: string) {
      updated.emit(tabId, { url });
    },
    async send(message: unknown, sender: MessageSender) {
      let response: unknown;
      let done = false;
      for (const listener of messages.listeners) {
        listener(message, sender, (value) => {
          response = value;
          done = true;
        });
      }
      for (let attempt = 0; attempt < 100 && !done; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return response;
    },
  };
}
