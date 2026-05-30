/**
 * Reject obviously internal webhook targets to limit SSRF. Hostname-based:
 * a defense-in-depth check, not a guarantee against DNS rebinding.
 */
export function isAllowedUrl(raw, allowPrivate) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (allowPrivate) return true;

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;

  // IPv6 loopback / unspecified
  if (host === "::1" || host === "[::1]" || host === "::" ) return false;

  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return false;                 // loopback
    if (a === 10) return false;                  // private
    if (a === 192 && b === 168) return false;    // private
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 169 && b === 254) return false;    // link-local
    if (a === 0) return false;                   // unspecified
  }
  return true;
}
