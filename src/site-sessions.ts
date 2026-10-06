export interface SiteSession {
  origin: string;
  tabId: number;
  frameId: number | null;
  documentId: string | null;
  epoch: number;
  state: 'pending' | 'active' | 'stopped';
  message: string | null;
  detached: boolean;
}

export interface SiteBind {
  tabId: number;
  frameId: number;
  documentId: string;
  origin: string;
}

const REAUTH = '需要重新授權這個網站';

export function createSiteSessions() {
  let epochSeed = 1;
  const byTab = new Map<number, SiteSession>();

  function stop(session: SiteSession, message: string): void {
    session.state = 'stopped';
    session.message = message;
    session.detached = false;
    session.epoch = epochSeed;
    epochSeed += 1;
  }

  return {
    start(origin: string, tabId: number): SiteSession {
      const session: SiteSession = {
        origin,
        tabId,
        frameId: null,
        documentId: null,
        epoch: epochSeed,
        state: 'pending',
        message: null,
        detached: false,
      };
      epochSeed += 1;
      byTab.set(tabId, session);
      return { ...session };
    },
    noteUrl(tabId: number, url: string): void {
      const session = byTab.get(tabId);
      if (!session || session.state === 'stopped') return;
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        stop(session, REAUTH);
        return;
      }
      if (origin !== session.origin) stop(session, REAUTH);
    },
    noteDetach(tabId: number): void {
      const session = byTab.get(tabId);
      if (!session || session.state === 'stopped') return;
      session.detached = true;
    },
    /** A dropped content-script port that never rebinds stops the session.
     * A same-origin reload rebinds first and does not stop. */
    expireDetach(tabId: number): void {
      const session = byTab.get(tabId);
      if (!session || !session.detached || session.state === 'stopped') return;
      stop(session, REAUTH);
    },
    permissionRemoved(origin: string): void {
      for (const session of byTab.values()) {
        if (session.origin === origin && session.state !== 'stopped') stop(session, '這個網站的授權已移除');
      }
    },
    stopAll(message: string): void {
      for (const session of byTab.values()) {
        if (session.state !== 'stopped') stop(session, message);
      }
    },
    bind(input: SiteBind): { ok: true; epoch: number } | { ok: false; error: string } {
      const session = byTab.get(input.tabId);
      if (!session || session.state === 'stopped') return { ok: false, error: 'session' };
      if (input.frameId !== 0) return { ok: false, error: 'frame' };
      if (input.origin !== session.origin) return { ok: false, error: 'origin' };
      if (!input.documentId || input.documentId.length > 128) return { ok: false, error: 'document' };
      session.frameId = 0;
      session.documentId = input.documentId;
      session.state = 'active';
      session.detached = false;
      return { ok: true, epoch: session.epoch };
    },
    authorize(input: SiteBind & { epoch: number }): boolean {
      const session = byTab.get(input.tabId);
      if (!session || session.state !== 'active') return false;
      return session.frameId === input.frameId
        && session.documentId === input.documentId
        && session.origin === input.origin
        && session.epoch === input.epoch
        && input.frameId === 0;
    },
    list(): SiteSession[] {
      return [...byTab.values()].map((session) => ({ ...session }));
    },
  };
}

export type SiteSessions = ReturnType<typeof createSiteSessions>;
