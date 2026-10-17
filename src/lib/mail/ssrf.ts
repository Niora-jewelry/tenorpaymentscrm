/**
 * The guard in front of the email image proxy.
 *
 * An email can contain `<img src="http://169.254.169.254/...">`. If the
 * server fetched that on a user's click, any sender could make our server
 * request our own cloud metadata or internal network. So every URL — and
 * every address it resolves to, and every redirect hop — is checked here
 * before a byte is fetched.
 *
 * The proxy route additionally never accepts a URL from the caller: it
 * takes a message id and an index into the image list recorded at ingest.
 * This guard is the second wall, for the case where a sender's URL itself
 * points somewhere internal.
 *
 * Pure: DNS resolution is injected so it can be tested without a network.
 */
import { isIP } from 'node:net';

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

/** IPv4 CIDRs that must never be fetched. */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}

function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

/** Expands an IPv6 literal to 8 groups of numbers. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // Embedded IPv4 tail (::ffff:1.2.3.4).
  const v4Tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    const n = v4ToInt(v4Tail[1]);
    s = s.slice(0, -v4Tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.length !== 8) return null;
  const nums = all.map((g) => parseInt(g || '0', 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

/** True for any address that is not a plain public unicast address. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED_V4.some(([base, bits]) => inV4(address, base, bits));
  if (family !== 6) return true;

  const g = v6Groups(address);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — judge the embedded v4.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return isBlockedAddress(v4);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

export type UrlCheck =
  | { ok: true; url: URL; address: string; family: number }
  | { ok: false; reason: 'scheme' | 'credentials' | 'port' | 'blocked_address' | 'unresolvable' | 'malformed' };

/**
 * Checks one URL. Returns the vetted address the caller must connect to —
 * connecting to the hostname again would let DNS answer differently the
 * second time (rebinding).
 */
export async function checkUrl(raw: string, lookup: Lookup): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (url.port && url.port !== '80' && url.port !== '443') return { ok: false, reason: 'port' };

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedAddress(host)) return { ok: false, reason: 'blocked_address' };
    return { ok: true, url, address: host, family: isIP(host) };
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host);
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'unresolvable' };
  // EVERY answer must be public: a host resolving to one public and one
  // private address is refused, not round-robined.
  if (addresses.some((a) => isBlockedAddress(a.address))) return { ok: false, reason: 'blocked_address' };
  return { ok: true, url, address: addresses[0].address, family: addresses[0].family };
}

/** Raster image types the proxy will pass, by magic bytes. Never SVG or HTML. */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return null;
}
