import assert from 'node:assert/strict';
import test from 'node:test';
import { handleWindowMessage } from '../src/content/page-messages.ts';
import { createRouter, type MessageSender } from '../src/messages.ts';
import { stagingProfile } from './support/profiles.ts';

const runtimeId = 'extensionidextensionidextensionid';

function page(url = `chrome-extension://${runtimeId}/index.html`): MessageSender {
  return { id: runtimeId, url };
}

function content(extra: Partial<MessageSender> = {}): MessageSender {
  return {
    id: runtimeId,
    origin: 'https://a.example',
    frameId: 0,
    documentId: 'doc-1',
    tab: { id: 7, url: 'https://a.example/path' },
    ...extra,
  };
}

function buildRouter(epoch = 3) {
  const calls = { native: 0, hello: 0, ping: 0 };
  const built = createRouter({
    runtimeId,
    platformOrigin: stagingProfile.origin,
    pairingEpoch: () => epoch,
    async snapshot() {
      return empty(epoch);
    },
    async begin() {
      return empty(epoch);
    },
    async disconnect() {
      return empty(epoch);
    },
    async openVerification() {
      return empty(epoch);
    },
    async modes() {
      calls.native += 1;
      return empty(epoch);
    },
    async startSite() {
      return empty(epoch);
    },
    async removeSite() {
      return empty(epoch);
    },
    async hello() {
      calls.hello += 1;
      return { ok: true, boundEpoch: 1 };
    },
    async ping() {
      calls.ping += 1;
      return { ok: true };
    },
  });
  return { router: built, calls };
}

function empty(epoch: number) {
  return {
    phase: 'disconnected',
    reason: null,
    userCode: null,
    verificationUri: null,
    expiresAt: null,
    connectionId: null,
    epoch,
    pollAfterMs: 0,
    modes: { extension_byok: 'available' as const, extension_cli: 'missing' as const },
    sites: [],
  };
}

test('EXT-02 rejects the wrong sender, an impersonating content script, and page postMessage', async () => {
  const { router, calls } = buildRouter();
  const wrongId = await router.handle({ type: 'pairing.snapshot', epoch: 0 }, { ...page(), id: 'other-extension' });
  assert.equal(wrongId.ok, false);
  assert.equal(wrongId.error, 'sender');

  const tabbedPanel = await router.handle(
    { type: 'pairing.snapshot', epoch: 0 },
    { id: runtimeId, url: `chrome-extension://${runtimeId}/index.html`, tab: { id: 4 } },
  );
  assert.equal(tabbedPanel.ok, true);
  assert.equal(tabbedPanel.snapshot?.phase, 'disconnected');

  const impersonator = await router.handle(
    { type: 'pairing.begin', epoch: 3 },
    content({ url: `chrome-extension://${runtimeId}/index.html` }),
  );
  assert.equal(impersonator.ok, false);
  assert.equal(impersonator.error, 'sender');

  const fromContent = await router.handle({ type: 'pairing.begin', epoch: 3 }, content());
  assert.equal(fromContent.error, 'context');

  const extensionHello = await router.handle({ type: 'site.hello' }, page());
  assert.equal(extensionHello.error, 'context');

  let sunk = 0;
  handleWindowMessage({ data: { type: 'pairing.begin', command: 'connectNative' } }, () => {
    sunk += 1;
  });
  assert.equal(sunk, 0);
  assert.equal(calls.native, 0);
});

test('EXT-09 rejects JSON that carries JS, eval, or a remote handler', async () => {
  const { router, calls } = buildRouter();
  const extra = await router.handle({ type: 'pairing.begin', epoch: 3, handler: 'eval(alert(1))' }, page());
  assert.equal(extra.error, 'schema');
  const remote = await router.handle({ type: 'site.start', epoch: 3, origin: 'https://a.example', tabId: 1, src: 'import("https://evil.example/a.js")' }, page());
  assert.equal(remote.error, 'schema');
  const origin = await router.handle({ type: 'site.start', epoch: 3, origin: 'javascript:alert(1)', tabId: 1 }, page());
  assert.equal(origin.error, 'schema');
  const fn = await router.handle({ type: 'pairing.snapshot', epoch: 0, run() { return 1; } }, page());
  assert.equal(fn.error, 'schema');
  const reserved = await router.handle({ type: 'dom.act', epoch: 3 }, page());
  assert.equal(reserved.error, 'schema');
  const oversize = await router.handle({ type: 'pairing.snapshot', epoch: 0, pad: 'x'.repeat(5000) }, page());
  assert.equal(oversize.error, 'oversize');
  assert.equal(calls.native, 0);
  assert.equal(calls.hello, 0);
});
