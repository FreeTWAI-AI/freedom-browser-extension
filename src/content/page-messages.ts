/** Page postMessage is untrusted. It has no path to runtime.sendMessage,
 * connectNative, or any privileged handler. The sink exists so tests can
 * prove it is never called. */
export function handleWindowMessage(event: unknown, sink?: (message: unknown) => void): void {
  void event;
  void sink;
}
