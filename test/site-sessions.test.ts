import assert from 'node:assert/strict';
import test from 'node:test';
import { createSiteSessions } from '../src/site-sessions.ts';

test('EXT-03 stops a site session when the tab origin changes', () => {
  const sites = createSiteSessions();
  const started = sites.start('https://a.example', 4);
  sites.noteUrl(4, 'https://a.example/next');
  assert.equal(sites.list()[0]?.state, 'pending');
  assert.equal(sites.list()[0]?.epoch, started.epoch);
  sites.noteUrl(4, 'https://b.example/landed');
  const stopped = sites.list()[0];
  assert.equal(stopped?.state, 'stopped');
  assert.equal(stopped?.message, '需要重新授權這個網站');
  assert.notEqual(stopped?.epoch, started.epoch);
  const rebound = sites.bind({ tabId: 4, frameId: 0, documentId: 'doc', origin: 'https://a.example' });
  assert.equal(rebound.ok, false);
});

test('removing a permission or ending pairing stops the site session', () => {
  const sites = createSiteSessions();
  sites.start('https://a.example', 4);
  sites.permissionRemoved('https://a.example');
  assert.equal(sites.list()[0]?.message, '這個網站的授權已移除');
  sites.start('https://c.example', 5);
  sites.stopAll('連線已結束，網站工作階段已停止');
  assert.equal(sites.list().find((site) => site.tabId === 5)?.message, '連線已結束，網站工作階段已停止');
});

test('a content script must bind frame 0 and the same document', () => {
  const sites = createSiteSessions();
  sites.start('https://a.example', 4);
  assert.equal(sites.bind({ tabId: 4, frameId: 1, documentId: 'doc', origin: 'https://a.example' }).ok, false);
  const bound = sites.bind({ tabId: 4, frameId: 0, documentId: 'doc', origin: 'https://a.example' });
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  assert.equal(sites.authorize({ tabId: 4, frameId: 0, documentId: 'other', origin: 'https://a.example', epoch: bound.epoch }), false);
  assert.equal(sites.authorize({ tabId: 4, frameId: 0, documentId: 'doc', origin: 'https://a.example', epoch: bound.epoch }), true);
});
