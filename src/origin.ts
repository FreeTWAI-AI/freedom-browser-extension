const forbiddenOrigin = /eval\s*\(|new\s+Function|function\s*\(|<script|javascript:|data:|import\s*\(/i;

export function parseHttpOrigin(value: string): string | null {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) return null;
  if (forbiddenOrigin.test(value) || /[\s?#\\@]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value || url.username || url.password) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin;
}

/** A site the member can grant. The platform origin is already the extension host permission. */
export function siteOrigin(value: string, platformOrigin: string): string | null {
  const origin = parseHttpOrigin(value);
  if (origin === null || origin === platformOrigin) return null;
  return origin;
}

export function patternToOrigin(pattern: string): string | null {
  if (!pattern.endsWith('/*')) return null;
  return parseHttpOrigin(pattern.slice(0, -2));
}
