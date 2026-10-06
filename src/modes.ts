export interface ModeReport {
  extension_byok: 'available';
  extension_cli: 'available' | 'missing';
}

interface NativePort {
  disconnect(): void;
  onDisconnect: { addListener(listener: () => void): void };
}

/** extension_byok does not need a Native Host and this extension never holds provider keys.
 * extension_cli is missing until nativeMessaging is granted and a host stays connected.
 * The probe sends no command. */
export async function readModes(chromeLike: {
  permissions: { contains(permission: { permissions: string[] }): Promise<boolean> };
  runtime: { connectNative(host: string): NativePort };
}, timeoutMs = 300): Promise<ModeReport> {
  const granted = await chromeLike.permissions.contains({ permissions: ['nativeMessaging'] });
  if (!granted) return { extension_byok: 'available', extension_cli: 'missing' };
  try {
    const port = chromeLike.runtime.connectNative('com.freetwai.freedom_browser');
    const dropped = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    try {
      port.disconnect();
    } catch {
      /* The host may already have closed the port. */
    }
    return { extension_byok: 'available', extension_cli: dropped ? 'missing' : 'available' };
  } catch {
    return { extension_byok: 'available', extension_cli: 'missing' };
  }
}
