import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientId = 'freedom-browser-extension';

export const profiles = {
  staging: {
    name: 'staging',
    origin: 'https://staging.freetwai.com',
    environment: 'staging-next',
    clientId,
    loopback: false,
    statusRecheckMs: 60_000,
  },
  production: {
    name: 'production',
    origin: 'https://freetwai.com',
    environment: 'next',
    clientId,
    loopback: false,
    statusRecheckMs: 60_000,
  },
  e2e: {
    name: 'e2e',
    origin: 'http://127.0.0.1:4391',
    environment: 'local',
    clientId,
    loopback: true,
    statusRecheckMs: 400,
  },
};

const csp = "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export function manifestFor(profile) {
  return {
    manifest_version: 3,
    name: '自由工坊',
    version: '0.1.0',
    description: '把這個瀏覽器連到自由工坊。',
    action: { default_title: '自由工坊' },
    side_panel: { default_path: 'index.html' },
    background: { service_worker: 'background.js', type: 'module' },
    permissions: ['sidePanel', 'storage', 'scripting', 'activeTab', 'alarms'],
    optional_permissions: ['nativeMessaging'],
    host_permissions: [`${profile.origin}/*`],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    content_security_policy: { extension_pages: csp },
  };
}

async function vite(entryRoot, outDir, profile, options) {
  await build({
    configFile: false,
    root: entryRoot,
    publicDir: false,
    base: './',
    logLevel: 'warn',
    mode: 'production',
    plugins: options.react ? [react()] : [],
    define: { __FREEDOM_BUILD_PROFILE__: JSON.stringify(profile) },
    build: {
      outDir,
      emptyOutDir: options.empty === true,
      sourcemap: false,
      target: 'chrome120',
      cssCodeSplit: false,
      modulePreload: false,
      rollupOptions: {
        input: options.input,
        output: {
          format: options.format,
          name: options.name,
          entryFileNames: options.file,
          assetFileNames: 'panel.[ext]',
          inlineDynamicImports: true,
        },
      },
    },
  });
}

export async function buildProfile(name) {
  const profile = profiles[name];
  if (!profile) throw new Error(`unknown_profile:${name}`);
  const outDir = path.join(root, 'dist', name);
  await mkdir(outDir, { recursive: true });
  await vite(path.join(root, 'src', 'panel'), outDir, profile, {
    react: true,
    empty: true,
    input: path.join(root, 'src', 'panel', 'index.html'),
    format: 'es',
    file: 'panel.js',
  });
  await vite(path.join(root, 'src', 'background'), outDir, profile, {
    input: path.join(root, 'src', 'background', 'index.ts'),
    format: 'es',
    file: 'background.js',
  });
  await vite(path.join(root, 'src', 'content'), outDir, profile, {
    input: path.join(root, 'src', 'content', 'index.ts'),
    format: 'iife',
    name: 'FreedomSiteSession',
    file: 'content.js',
  });
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifestFor(profile), null, 2)}\n`);
}

const requested = process.argv[2] ?? 'staging';
const names = requested === 'all' ? ['staging', 'production', 'e2e'] : [requested];
for (const name of names) await buildProfile(name);
