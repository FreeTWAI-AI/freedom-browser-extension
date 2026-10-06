import { useEffect, useState } from 'react';
import { phaseLabel, reasonHint } from '../labels.ts';
import { siteOrigin } from '../origin.ts';
import type { PublicPhase } from '../pairing-client.ts';
import { currentProfile } from '../profile.ts';

interface SiteRow {
  origin: string;
  tabId: number | null;
  state: string;
  message: string | null;
}

interface Snapshot {
  phase: PublicPhase;
  reason: string | null;
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: string | null;
  connectionId: string | null;
  epoch: number;
  pollAfterMs: number;
  modes: { extension_byok: 'available'; extension_cli: 'available' | 'missing' };
  sites: SiteRow[];
}

interface ActiveTab {
  origin: string | null;
  tabId: number | null;
  note: string | null;
}

async function send(message: unknown): Promise<{ ok?: boolean; snapshot?: Snapshot; error?: string }> {
  return chrome.runtime.sendMessage(message);
}

function isPhase(value: string): value is PublicPhase {
  return value === 'disconnected' || value === 'waiting' || value === 'connected' || value === 'revoked' || value === 'expired' || value === 'reconnect';
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [active, setActive] = useState<ActiveTab>({ origin: null, tabId: null, note: null });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    async function tick(): Promise<void> {
      try {
        const response = await send({ type: 'pairing.snapshot', epoch: 0 });
        if (!stopped && response.snapshot && isPhase(response.snapshot.phase)) setSnapshot(response.snapshot);
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const tab = tabs[0];
        if (stopped) return;
        if (!tab || tab.id == null || !tab.url) {
          setActive({ origin: null, tabId: tab?.id ?? null, note: '先開啟要授權的分頁，再按擴充功能圖示。' });
          return;
        }
        let parsed: string | null = null;
        try {
          parsed = new URL(tab.url).origin;
        } catch {
          parsed = null;
        }
        const origin = parsed ? siteOrigin(parsed, currentProfile().origin) : null;
        if (!origin) {
          setActive({ origin: null, tabId: tab.id, note: '這個分頁不能授權。' });
          return;
        }
        setActive({ origin, tabId: tab.id, note: null });
      } catch {
        if (!stopped) setNotice('這次沒有完成，請再試一次。');
      }
    }
    void tick();
    const timer = setInterval(() => void tick(), 300);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  async function mutate(message: unknown): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const response = await send(message);
      if (response.snapshot && isPhase(response.snapshot.phase)) setSnapshot(response.snapshot);
      else setNotice('這次沒有完成，請再試一次。');
    } catch {
      setNotice('這次沒有完成，請再試一次。');
    } finally {
      setBusy(false);
    }
  }

  async function onGrant(): Promise<void> {
    if (!snapshot || !active.origin || active.tabId == null) return;
    const origin = active.origin;
    const tabId = active.tabId;
    const epoch = snapshot.epoch;
    setBusy(true);
    setNotice(null);
    try {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) return;
      const response = await send({ type: 'site.start', epoch, origin, tabId });
      if (response.snapshot && isPhase(response.snapshot.phase)) setSnapshot(response.snapshot);
      else setNotice('這次沒有完成，請再試一次。');
    } catch {
      setNotice('這次沒有完成，請再試一次。');
    } finally {
      setBusy(false);
    }
  }

  if (!snapshot) {
    return (
      <main className="column" data-phase="loading">
        <h1>自由工坊</h1>
        <p id="phase" aria-live="polite">讀取連線狀態。</p>
      </main>
    );
  }

  const hint = reasonHint(snapshot.phase, snapshot.reason);
  const terminal = snapshot.phase === 'revoked' || snapshot.phase === 'expired' || snapshot.phase === 'reconnect';
  const showGrant = snapshot.phase === 'connected' && active.origin && !snapshot.sites.some((site) => site.origin === active.origin && site.state !== 'stopped');

  return (
    <main className="column" data-phase={snapshot.phase}>
      <h1>自由工坊</h1>
      <p id="phase" aria-live="polite">{phaseLabel(snapshot.phase)}</p>
      {hint ? <p className={snapshot.phase === 'revoked' || snapshot.phase === 'expired' ? 'danger' : 'muted'}>{hint}</p> : null}
      {snapshot.userCode ? <p id="user-code" className="user-code">{snapshot.userCode}</p> : <p id="user-code" hidden />}
      {snapshot.verificationUri ? <p className="muted">{snapshot.verificationUri}</p> : null}
      {notice ? <p className="danger" role="status">{notice}</p> : null}

      {snapshot.phase === 'disconnected' || terminal ? (
        <button id="connect" className="primary" type="button" disabled={busy} onClick={() => void mutate({ type: 'pairing.begin', epoch: snapshot.epoch })}>
          {snapshot.phase === 'disconnected' ? '連接' : '重新連接'}
        </button>
      ) : null}
      {snapshot.phase === 'waiting' ? (
        <button id="verify" className="primary" type="button" disabled={busy} onClick={() => void mutate({ type: 'pairing.openVerification', epoch: snapshot.epoch })}>
          開啟確認頁
        </button>
      ) : null}
      {snapshot.phase === 'waiting' || snapshot.phase === 'connected' ? (
        <button id="disconnect" type="button" disabled={busy} onClick={() => void mutate({ type: 'pairing.disconnect', epoch: snapshot.epoch })}>
          中斷連線
        </button>
      ) : null}

      <h2>執行方式</h2>
      <p>平台保管：可用</p>
      <p className="muted">不保存供應商金鑰</p>
      <p>本機命令列：{snapshot.modes.extension_cli === 'available' ? '可用' : '缺少'}</p>

      <h2>網站授權</h2>
      {snapshot.sites.length === 0 ? <p className="muted">尚未授權網站</p> : null}
      <ul>
        {snapshot.sites.map((site) => (
          <li key={`${site.tabId ?? 'none'}:${site.origin}`}>
            <p>{site.origin}</p>
            {site.message ? <p className="danger">{site.message}</p> : <p className="muted">{site.state === 'active' ? '使用中' : site.state === 'pending' ? '等待頁面' : '已停止'}</p>}
            <button type="button" disabled={busy} onClick={() => void mutate({ type: 'site.removePermission', epoch: snapshot.epoch, origin: site.origin })}>
              移除
            </button>
          </li>
        ))}
      </ul>
      {showGrant ? (
        <button id="grant" className="primary" type="button" disabled={busy} onClick={() => void onGrant()}>
          授權這個網站
        </button>
      ) : null}
      {snapshot.phase === 'connected' && active.note ? <p className="muted">{active.note}</p> : null}
    </main>
  );
}
