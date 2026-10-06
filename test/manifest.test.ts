import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const forbidden = ['<all_urls>', 'cookies', 'history', 'bookmarks', 'debugger', 'unlimitedStorage', 'webRequest', 'tabs'];
const csp = "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

const expected: Record<string, string> = {
  staging: 'https://staging.freetwai.com/*',
  production: 'https://freetwai.com/*',
  e2e: 'http://127.0.0.1:4391/*',
};

test('every built manifest is the closed MV3 grant', async () => {
  for (const [name, host] of Object.entries(expected)) {
    const manifest = JSON.parse(await readFile(path.join(root, 'dist', name, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ['sidePanel', 'storage', 'scripting', 'activeTab', 'alarms']);
    assert.deepEqual(manifest.optional_permissions, ['nativeMessaging']);
    assert.deepEqual(manifest.host_permissions, [host]);
    assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
    assert.equal((manifest.content_security_policy as { extension_pages: string }).extension_pages, csp);
    assert.equal(Object.hasOwn(manifest, 'externally_connectable'), false);
    assert.equal(Object.hasOwn(manifest, 'content_scripts'), false);
    assert.equal(Object.hasOwn(manifest, 'web_accessible_resources'), false);
    const granted = JSON.stringify({
      permissions: manifest.permissions,
      optional_permissions: manifest.optional_permissions,
      host_permissions: manifest.host_permissions,
    });
    for (const name of forbidden) assert.equal(granted.includes(name), false, name);
    assert.equal(csp.includes('unsafe-eval'), false);
    assert.equal(csp.includes('http'), false);
    const background = manifest.background as { service_worker: string; type: string };
    assert.equal(background.service_worker, 'background.js');
    assert.equal(background.type, 'module');
    assert.equal((manifest.side_panel as { default_path: string }).default_path, 'index.html');
  }
});
