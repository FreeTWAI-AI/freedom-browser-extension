import { handleWindowMessage } from './page-messages.ts';

const port = chrome.runtime.connect({ name: 'site-session' });
port.postMessage({ type: 'site.hello' });
window.addEventListener('message', (event) => {
  handleWindowMessage(event);
});
port.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const record = message as { type?: unknown; epoch?: unknown };
  if (record.type !== 'site.bound' || typeof record.epoch !== 'number') return;
  // CLIENT-A2 will send observations on this port. A1 only keeps the binding.
});
