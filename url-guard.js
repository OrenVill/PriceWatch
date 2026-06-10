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

  // IPv6: URL() reports the address bracketed, e.g. "[::1]". Strip brackets to test.
  if (host.startsWith("[") && host.endsWith("]")) {
    const ip6 = host.slice(1, -1);
    if (ip6 === "::1" || ip6 === "::") return false;        // loopback / unspecified
    if (ip6.startsWith("fe8") || ip6.startsWith("fe9") ||
        ip6.startsWith("fea") || ip6.startsWith("feb")) return false; // fe80::/10 link-local
    if (ip6.startsWith("fc") || ip6.startsWith("fd")) return false;   // fc00::/7 unique-local
    // IPv4-mapped (::ffff:a.b.c.d). URL() normalizes the trailing 32 bits to
    // hex (e.g. ::ffff:127.0.0.1 → ::ffff:7f00:1), so decode that to dotted-quad.
    const mappedHex = ip6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      const dotted = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
      return isPrivateIPv4(dotted) ? false : true;
    }
    const mappedDotted = ip6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mappedDotted) return isPrivateIPv4(mappedDotted[1]) ? false : true;
    return true;
  }

  if (isPrivateIPv4(host)) return false;
  return true;
}

function isPrivateIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true;                 // loopback
  if (a === 10) return true;                  // private
  if (a === 192 && b === 168) return true;    // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 169 && b === 254) return true;    // link-local
  if (a === 0) return true;                   // unspecified
  return false;
}
