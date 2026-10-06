import type { DeviceKeyStore } from '../device-key.ts';
import { createRouter, type ExtensionSnapshot, type MessageSender } from '../messages.ts';
import { readModes, type ModeReport } from '../modes.ts';
import { patternToOrigin } from '../origin.ts';
import { createPairingClient, type Clock } from '../pairing-client.ts';
import type { BuildProfile } from '../profile.ts';
import type { SessionStore } from '../session-store.ts';
import { createSiteSessions } from '../site-sessions.ts';

const PAIRING_ENDED = '連線已結束，網站工作階段已停止';

interface NativePort {
  disconnect(): void;
  onDisconnect: { addListener(listener: () => void): void };
}

export interface ChromePort {
  name: string;
  sender?: MessageSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface ChromeBridge {
  runtime: {
    id: string;
    onMessage: {
      addListener(listener: (message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | void): void;
    };
    onConnect: { addListener(listener: (port: ChromePort) => void): void };
    connectNative(host: string): NativePort;
  };
  alarms: {
    create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
    onAlarm: { addListener(listener: (alarm: { name: string }) => void): void };
  };
  tabs: {
    create(options: { url: string }): Promise<unknown> | unknown;
    onUpdated: { addListener(listener: (tabId: number, changeInfo: { url?: string }) => void): void };
  };
  permissions: {
    contains(permission: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    remove(permission: { origins?: string[] }): Promise<boolean>;
    onRemoved: { addListener(listener: (removed: { origins?: string[] }) => void): void };
  };
  scripting: {
    executeScript(injection: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  };
}

export interface RuntimeControl {
  pump(): Promise<void>;
  snapshot(): Promise<ExtensionSnapshot>;
  stop(): void;
}

export async function startRuntime(deps: {
  profile: BuildProfile;
  fetchImpl: typeof fetch;
  clock: Clock;
  keys: DeviceKeyStore;
  store: SessionStore;
  chrome: ChromeBridge;
  schedule?: boolean;
}): Promise<RuntimeControl> {
  let router: ReturnType<typeof createRouter> | undefined;
  deps.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!router) {
      sendResponse({ ok: false, error: 'starting' });
      return true;
    }
    void router.handle(message, sender).then(sendResponse, () => sendResponse({ ok: false, error: 'rejected' }));
    return true;
  });
  const client = await createPairingClient(deps);
  const sites = createSiteSessions();
  let modes: ModeReport = { extension_byok: 'available', extension_cli: 'missing' };
  let timer: ReturnType<typeof setTimeout> | undefined;

  function applyStopped(): void {
    if (client.view().phase !== 'connected') sites.stopAll(PAIRING_ENDED);
  }

  async function snapshot(): Promise<ExtensionSnapshot> {
    const view = client.view();
    return {
      phase: view.phase,
      reason: view.reason,
      userCode: view.userCode,
      verificationUri: view.verificationUri,
      expiresAt: view.expiresAt,
      connectionId: view.connectionId,
      epoch: view.epoch,
      pollAfterMs: view.pollAfterMs,
      modes,
      sites: sites.list().map((session) => ({
        origin: session.origin,
        tabId: session.tabId,
        state: session.state,
        message: session.message,
      })),
    };
  }

  async function refreshModes(): Promise<ExtensionSnapshot> {
    modes = await readModes(deps.chrome);
    return snapshot();
  }

  async function begin(): Promise<ExtensionSnapshot> {
    await client.begin();
    applyStopped();
    return snapshot();
  }

  async function disconnect(): Promise<ExtensionSnapshot> {
    await client.disconnect();
    applyStopped();
    return snapshot();
  }

  async function openVerification(): Promise<ExtensionSnapshot> {
    const uri = client.verificationUri();
    if (uri) await deps.chrome.tabs.create({ url: uri });
    return snapshot();
  }

  async function startSite(origin: string, tabId: number): Promise<ExtensionSnapshot> {
    if (client.view().phase !== 'connected') throw new Error('not_connected');
    const granted = await deps.chrome.permissions.contains({ origins: [`${origin}/*`] });
    if (!granted) throw new Error('permission_required');
    await deps.chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    sites.start(origin, tabId);
    return snapshot();
  }

  async function removeSite(origin: string): Promise<ExtensionSnapshot> {
    await deps.chrome.permissions.remove({ origins: [`${origin}/*`] });
    sites.permissionRemoved(origin);
    return snapshot();
  }

  router = createRouter({
    runtimeId: deps.chrome.runtime.id,
    platformOrigin: deps.profile.origin,
    pairingEpoch: () => client.view().epoch,
    snapshot,
    begin,
    disconnect,
    openVerification,
    modes: refreshModes,
    startSite,
    removeSite,
    async hello(sender) {
      const tabId = sender.tab?.id;
      if (tabId == null || sender.frameId == null || !sender.documentId || !sender.origin) return { ok: false, error: 'sender' };
      const bound = sites.bind({ tabId, frameId: sender.frameId, documentId: sender.documentId, origin: sender.origin });
      if (!bound.ok) return { ok: false, error: bound.error };
      return { ok: true, boundEpoch: bound.epoch, snapshot: await snapshot() };
    },
    async ping(sender, epoch) {
      const tabId = sender.tab?.id;
      if (tabId == null || sender.frameId == null || !sender.documentId || !sender.origin) return { ok: false, error: 'sender' };
      const allowed = sites.authorize({ tabId, frameId: sender.frameId, documentId: sender.documentId, origin: sender.origin, epoch });
      if (!allowed) return { ok: false, error: 'session' };
      return { ok: true, snapshot: await snapshot() };
    },
  });

  deps.chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'site-session') {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((message) => {
      void router.handle(message, port.sender ?? {}).then((result) => {
        if (result.ok && result.boundEpoch !== undefined) port.postMessage({ type: 'site.bound', epoch: result.boundEpoch });
      });
    });
    port.onDisconnect.addListener(() => {
      const tabId = port.sender?.tab?.id;
      if (tabId == null) return;
      sites.noteDetach(tabId);
      setTimeout(() => sites.expireDetach(tabId), 1500);
    });
  });

  deps.chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) sites.noteUrl(tabId, changeInfo.url);
  });

  deps.chrome.permissions.onRemoved.addListener((removed) => {
    for (const pattern of removed.origins ?? []) {
      const origin = patternToOrigin(pattern);
      if (origin) sites.permissionRemoved(origin);
    }
  });

  deps.chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'freedom.maintenance') void pump();
  });
  void deps.chrome.alarms.create('freedom.maintenance', { periodInMinutes: 1 });

  async function pump(): Promise<void> {
    try {
      const phase = client.view().phase;
      if (phase === 'waiting') await client.poll();
      else if (client.shouldRecheck(deps.profile.statusRecheckMs)) await client.readStatus();
      applyStopped();
    } catch {
      /* A concurrent exchange owns the client. The next wake retries the read. */
    }
  }

  function arm(): void {
    const view = client.view();
    const delay = view.phase === 'waiting' ? Math.max(50, view.pollAfterMs) : deps.profile.statusRecheckMs;
    timer = setTimeout(() => {
      void pump().finally(arm);
    }, delay);
  }

  if (deps.schedule !== false) arm();
  void refreshModes();

  return {
    pump,
    snapshot,
    stop() {
      if (timer) clearTimeout(timer);
    },
  };
}
