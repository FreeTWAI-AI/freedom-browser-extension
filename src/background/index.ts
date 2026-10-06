import { createIndexedDbKeyStore } from '../device-key.ts';
import { currentProfile } from '../profile.ts';
import { createChromeSessionStore } from '../session-store.ts';
import { startRuntime, type ChromeBridge } from './runtime.ts';

const profile = currentProfile();
const area = chrome.storage.session;
const store = createChromeSessionStore({
  get: (keys) => area.get(keys),
  set: (items) => area.set(items),
  remove: (keys) => area.remove(keys),
});

void startRuntime({
  profile,
  fetchImpl: globalThis.fetch.bind(globalThis),
  clock: { now: () => Date.now() },
  keys: createIndexedDbKeyStore(),
  store,
  schedule: true,
  chrome: {
    runtime: {
      id: chrome.runtime.id,
      onMessage: chrome.runtime.onMessage,
      onConnect: chrome.runtime.onConnect,
      connectNative: (host) => chrome.runtime.connectNative(host),
    },
    alarms: {
      create: (name, info) => chrome.alarms.create(name, info),
      onAlarm: chrome.alarms.onAlarm,
    },
    tabs: {
      create: (options) => chrome.tabs.create(options),
      onUpdated: chrome.tabs.onUpdated,
    },
    permissions: {
      contains: (permission) => chrome.permissions.contains(permission as chrome.permissions.Permissions),
      remove: (permission) => chrome.permissions.remove(permission as chrome.permissions.Permissions),
      onRemoved: chrome.permissions.onRemoved,
    },
    scripting: {
      executeScript: (injection) => chrome.scripting.executeScript(injection),
    },
  } as ChromeBridge,
}).catch(() => {
  // The panel stays on the loading sentence until a snapshot arrives.
});
