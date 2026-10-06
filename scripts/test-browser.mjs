import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createClock } from '../test/support/clock.ts';
import { createFakePlatform } from '../test/support/fake-platform.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'test-results', 'shots');
const resultPath = path.join(root, 'test-results', 'browser-result.json');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))));
  });
}

async function post(pathname, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:4391${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} ${response.status}`);
  return JSON.parse(text);
}

const clock = createClock(Date.now());
clock.now = () => Date.now();
const platform = createFakePlatform({
  clock,
  origin: 'http://127.0.0.1:4391',
  clientId: 'freedom-browser-extension',
  environment: 'local',
});
let server;
let context;
let userData = '';
try {
  await run(process.execPath, ['scripts/build.mjs', 'e2e']);
  await mkdir(shots, { recursive: true });
  server = await platform.listen(4391);
  userData = await mkdtemp(path.join(os.tmpdir(), 'freedom-ext-'));
  const extension = path.join(root, 'dist', 'e2e');
  context = await chromium.launchPersistentContext(userData, {
    headless: false,
    viewport: { width: 360, height: 640 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--headless=new',
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`PAGEERROR ${error.message}`));
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await page.waitForSelector('#connect', { timeout: 10_000 });
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  if (focused !== 'connect') throw new Error(`keyboard_connect:${focused || 'none'}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const node = document.querySelector('#user-code');
    return Boolean(node && node.textContent && node.textContent.trim().includes('-'));
  }, null, { timeout: 15_000 });
  const plate = await page.evaluate(() => getComputedStyle(document.querySelector('#user-code')).backgroundColor);
  if (plate === 'rgba(0, 0, 0, 0)' || plate === 'transparent') throw new Error('user_code_plate_missing');
  await page.keyboard.press('Tab');
  const waitingFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);
  if (waitingFocus !== 'verify') throw new Error(`keyboard_verify:${waitingFocus || 'none'}`);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 360, height: 640 });
  await page.screenshot({ path: path.join(shots, 'waiting-light-360.png') });
  const userCode = (await page.locator('#user-code').innerText()).trim();
  const inspected = await post('/api/v1/me/device-authorizations/inspect', { userCode });
  await post('/api/v1/me/device-authorizations/decide', {
    userCode,
    authorizationId: inspected.authorizationId,
    requestDigest: inspected.requestDigest,
    decision: 'approve',
  }, { 'Idempotency-Key': crypto.randomUUID() });
  await page.waitForFunction(() => document.querySelector('#phase')?.textContent === '已連接', null, { timeout: 30_000 });
  await page.screenshot({ path: path.join(shots, 'connected-light-360.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: path.join(shots, 'connected-light-1280.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: path.join(shots, 'connected-light-1440.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(shots, 'connected-dark-390.png') });
  const listed = await post('/api/v1/me/agent-connections');
  const connectionId = listed.connections[0]?.connectionId;
  if (!connectionId) throw new Error('missing_connection');
  await post(`/api/v1/me/agent-connections/${connectionId}:revoke`, {}, {
    'Idempotency-Key': crypto.randomUUID(),
    'If-Match': '1',
  });
  await page.waitForFunction(() => document.querySelector('#phase')?.textContent === '已撤銷', null, { timeout: 15_000 });
  await page.screenshot({ path: path.join(shots, 'revoked-dark-390.png') });
  const phase = await page.locator('#phase').innerText();
  await writeFile(resultPath, `${JSON.stringify({ status: 'passed', phase, extensionId, focused, waitingFocus, plate }, null, 2)}\n`);
  console.log(`browser passed phase=${phase} focused=${focused} waitingFocus=${waitingFocus}`);
} catch (error) {
  if (context) {
    const pages = context.pages();
    for (const open of pages) {
      const phase = await open.locator('#phase').innerText().catch(() => '');
      console.log(`URL ${open.url()}`);
      console.log(`PHASE ${phase}`);
    }
  }
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  await writeFile(resultPath, `${JSON.stringify({ status: 'failed', message }, null, 2)}\n`).catch(() => undefined);
  console.error(message);
  process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => undefined);
  if (server) await server.close().catch(() => undefined);
  if (userData) await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}
