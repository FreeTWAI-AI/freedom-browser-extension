export type RuntimeEnvironment = 'local' | 'staging-next' | 'next';
export type ProfileName = 'staging' | 'production' | 'e2e';

export interface BuildProfile {
  name: ProfileName;
  origin: string;
  environment: RuntimeEnvironment;
  clientId: string;
  /** True only for the test-only loopback build. Staging and production must be false. */
  loopback: boolean;
  statusRecheckMs: number;
}

declare const __FREEDOM_BUILD_PROFILE__: BuildProfile;

const CLIENT_ID = 'freedom-browser-extension';

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

/** Rejects a production or staging profile that does not match its fixed origin.
 * The active origin is a build constant. Messages cannot replace it. */
export function assertProfile(profile: BuildProfile): void {
  let url: URL;
  try {
    url = new URL(profile.origin);
  } catch {
    throw new Error('configuration_invalid');
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.origin !== profile.origin || profile.clientId !== CLIENT_ID) throw new Error('configuration_invalid');
  if (!Number.isInteger(profile.statusRecheckMs) || profile.statusRecheckMs < 200 || profile.statusRecheckMs > 3_600_000) {
    throw new Error('configuration_invalid');
  }
  if (profile.name === 'production') {
    if (profile.loopback || loopback || url.protocol !== 'https:' || profile.origin !== 'https://freetwai.com' || profile.environment !== 'next') {
      throw new Error('configuration_invalid');
    }
    return;
  }
  if (profile.name === 'staging') {
    if (profile.loopback || loopback || url.protocol !== 'https:' || profile.origin !== 'https://staging.freetwai.com' || profile.environment !== 'staging-next') {
      throw new Error('configuration_invalid');
    }
    return;
  }
  if (profile.name === 'e2e') {
    if (!profile.loopback || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '4391' || profile.environment !== 'local') {
      throw new Error('configuration_invalid');
    }
    return;
  }
  throw new Error('configuration_invalid');
}

export function currentProfile(): BuildProfile {
  const profile = __FREEDOM_BUILD_PROFILE__;
  assertProfile(profile);
  return Object.freeze({ ...profile });
}
