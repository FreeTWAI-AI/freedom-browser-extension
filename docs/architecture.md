# Architecture

CLIENT-A1 is a Manifest V3 shell. It pairs the browser to Freedom Workshop, keeps bootstrap credentials in the service worker, and rejects untyped messages. CLIENT-A2 (DOM actions, the durable journal, Stop/takeover, real site actions) is not implemented. Reserved message names live in `src/extension-points/a2.ts` and the router rejects them.

## Components and trust boundaries

```
side panel (extension page)
    |  chrome.runtime.sendMessage, schema checked
    v
background service worker  ---- fetch, redirect:'error', credentials:'omit' ---->  platform origin only
    |  owns tokens, device key, site sessions, native-host probe
    |  chrome.runtime.connect name "site-session"
    v
content script (isolated world)
    x  window.postMessage from the page is discarded
page
```

- The service worker is the only component that calls the platform, holds tokens, or probes Native Messaging.
- The side panel can ask the worker to start pairing, open the stored verification URI, disconnect, or grant a site. It never receives the access token, device code, or refresh handle.
- A content script may only bind and ping a site session the member already started. It cannot start pairing or Native Messaging.
- Page `window.postMessage` has no path to `runtime.sendMessage` or `connectNative`. `externally_connectable` is omitted, and `onMessageExternal` is not registered.
- `extension_byok` means the extension can run without a Native Host because platform_vault brokers model calls. This build does not call model or execution routes. The extension never stores provider keys.
- `extension_cli` is `missing` unless `nativeMessaging` is granted and `com.freetwai.freedom_browser` stays connected for the probe. The probe sends no command. There is no Native Host in this repository.

## Message schema

One router (`src/messages.ts`) handles every runtime message. Each message is JSON, at most 4096 bytes, with a closed key set. Extra fields, functions, prototype keys, `eval`, `new Function`, `javascript:`, `data:`, `<script`, `import(`, and `http(s)` URLs are rejected. An `origin` field may be an `http` or `https` origin and cannot be the platform origin.

The sender's `id` must equal `chrome.runtime.id`. An extension page is a `chrome-extension://<id>/` URL. Opening that page in a tab still counts as an extension page: without the `tabs` permission `tab.url` is omitted, and a content script cannot show this extension's URL while `tab.url` is a website. If `tab.url` is a website and `sender.url` claims the extension, the message is rejected. Content scripts have `tab.id` and are not extension pages.

| Type | Sender | Required fields | Effect |
| --- | --- | --- | --- |
| `pairing.snapshot` | extension page | `type`, `epoch` (`0` or the current pairing epoch) | Read-only state |
| `pairing.begin` | extension page | `type`, `epoch` | Start device authorization |
| `pairing.openVerification` | extension page | `type`, `epoch` | Worker opens the stored verification URI |
| `pairing.disconnect` | extension page | `type`, `epoch` | Wipe local session state |
| `modes.snapshot` | extension page | `type`, `epoch` | Re-probe mode availability |
| `site.list` | extension page | `type`, `epoch` | Same snapshot, including sites |
| `site.start` | extension page | `type`, `epoch`, `origin`, `tabId` | Inject `content.js` after a host grant |
| `site.removePermission` | extension page | `type`, `epoch`, `origin` | Remove the origin grant and stop sessions |
| `site.hello` | content script | `type` | Bind frame 0, `documentId`, and origin |
| `site.ping` | content script | `type`, `epoch` | Allowed only for the bound site epoch |
| `dom.observe`, `dom.act`, `journal.append`, `control.stop`, `control.takeover` | any | reserved | Rejected until CLIENT-A2 |

Mutating extension messages require the current pairing epoch. Content-script `site.ping` uses the site-session epoch. `site.hello` and `site.ping` also require `frameId === 0`, the bound `documentId`, and the granted origin.

## Storage

| Data | Location | Lifetime |
| --- | --- | --- |
| Access token, refresh handle, device code, user code, pairing phase | `chrome.storage.session` key `freedom.pairing` | Dies when the browser session ends |
| ECDSA P-256 private key | IndexedDB `freedom-browser-extension` / `device-key` / `current`, `extractable: false` | Until pairing ends or a new pairing replaces it. Never exported |
| Site host grants | Chrome's permission store, one origin pattern at a time | Until the member removes them |
| `chrome.storage.local`, `chrome.storage.sync` | not used | Token-like values are rejected if a caller tries |

A new browser session has empty session storage, so the old access token is not sent again. A service-worker restart in the same browser session may resume a waiting code only when no enrollment or refresh request was already armed. If a request was armed, or the phase was `beginning`, the worker quarantines instead of sending it again.

The project manifest cannot name `chrome.storage.session`. `stores_plaintext_credentials` stays false because the schema's true value is only the file-cache exception and forbids browser storage. `dynamic_credential_storage: ["client_owned"]` and `credential_root_key_storage: client_owned` mean the session tokens and the IndexedDB device key, not a PostgreSQL KEK.

## Permissions

| Grant | Why |
| --- | --- |
| `sidePanel` | The pairing UI is the side panel |
| `storage` | Session storage for the pairing record |
| `scripting` | Inject `content.js` into a tab after that origin is granted |
| `activeTab` | Read the current tab URL after the member invokes the extension, without the `tabs` permission |
| `alarms` | Wake a stopped service worker. The 5 second device-code poll uses `setTimeout` while the worker is alive. After a kill, the alarm period is 1 minute, and the device code still expires at 300 seconds |
| `nativeMessaging` (optional) | CLI mode probe only |
| host permission | Exactly the build profile's platform origin |
| `optional_host_permissions` `https://*/*` and `http://*/*` | Patterns the member can grant per origin. They are not in the default grant and are not `<all_urls>` |

Not requested: `<all_urls>`, `cookies`, `history`, `bookmarks`, `debugger`, `unlimitedStorage`, `webRequest`, `tabs`. `tabs.create` and a limited `tabs.onUpdated` are available without the `tabs` permission for tabs the extension may see. `tabs.query` in the panel relies on `activeTab` for the current tab URL.

`content_security_policy.extension_pages` is `script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`. No `unsafe-eval` and no remote script host.

## Build profiles

`npm run build` writes `dist/staging`. `build:production` and `build:e2e` write the other profiles. The profile is compiled in as `__FREEDOM_BUILD_PROFILE__`.

| Profile | Origin | Environment | Status recheck |
| --- | --- | --- | --- |
| staging | `https://staging.freetwai.com` | `staging-next` | 60s |
| production | `https://freetwai.com` | `next` | 60s |
| e2e | `http://127.0.0.1:4391` | `local` | 400ms |

`client_id` is `freedom-browser-extension` in every profile. The platform has not registered an extension client yet. Staging and production call `assertProfile` and reject a loopback or any other origin. The e2e origin exists only in the e2e build and in tests.

## Pairing state machine

States shown in the panel:

- 未連接 (`disconnected`)
- 等待你在自由工坊確認 (`waiting`) — user code and 開啟確認頁
- 已連接 (`connected`)
- 已撤銷 (`revoked`)
- 已過期 (`expired`)
- 需要重新連接 (`reconnect`) — denied, or an uncertain exchange

Flow:

1. `POST /execution-api/v1/auth/device-authorizations` with a DPoP proof (`freedom-device-pairing+jwt`, ES256, P-256 public JWK) and `runtime_kind: "extension"`.
2. Show the user code. Poll `POST /execution-api/v1/auth/token` with `grant_type` body field `grantType: "device_code"`. The first poll may run immediately. Later polls wait the server interval (literal 5 seconds at the start, `slow_down` increases it, cap 325).
3. `proof_required` returns an enrollment challenge. The next poll, after the interval, sends `enrollmentProof` (`freedom-runtime-enrollment+jws` over the raw payload). The armed flag is stored before that request.
4. `issued` stores the access token and refresh handle in session storage.
5. `POST /execution-api/v1/auth/nonce` then `GET /execution-api/v1/bootstrap` re-check the connection. Refresh uses `grantType: "refresh_token"`.

Definite results: `access_denied` → 需要重新連接, `expired_token` or the 300 second deadline → 已過期, HTTP 401/403 on refresh or status (including `agent_connection_unavailable` and refresh-handle reuse) → 已撤銷 and the session record is wiped. A Chrome host permission does not keep a revoked pairing usable.

Uncertain results quarantine to 需要重新連接 and are not retried: redirect, abort, transport failure, malformed JSON, or an oversized body. `fetch` uses `redirect: 'error'`, `credentials: 'omit'`, a 10 second deadline, and a 32 KiB body cap.

中斷連線 only deletes local session state and the device key. This extension has no member cookie, so it does not call the member revoke route.

Each `begin` creates a new nonextractable device key. An enrolled key is not reused after the refresh handle is gone.

## Site access

The panel's 授權這個網站 handler calls `chrome.permissions.request` as its first await, inside the click. The worker then injects `content.js` and starts one session for that tab. If the tab navigates to another origin, the session stops and the panel can show 需要重新授權這個網站. Removing the permission, disconnecting, or a revoked pairing stops it too. A same-origin path change does not. That cross-document behavior belongs to CLIENT-A2.

## What CLIENT-A2 will add

DOM vocabulary (`dom.observe`, `dom.act`), the durable journal (`journal.append`), and Stop/takeover (`control.stop`, `control.takeover`). Those types are reserved and rejected. A2 will also define what a content script may do after `site.bound`. This shell does not run models and does not act on page DOM.
