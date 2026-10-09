import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Outbound requests to user-supplied URLs (webhooks) must not reach the server's own network: loopback,
 * private, link-local (cloud metadata), CGNAT, multicast and unspecified addresses are refused.
 * Set WEBHOOK_ALLOW_PRIVATE=1 to allow them (local development, tests, on-prem receivers).
 */
export function privateTargetsAllowed(): boolean {
  return process.env.WEBHOOK_ALLOW_PRIVATE === '1';
}

export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedV4(mapped[1]);
    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) || // unique local fc00::/7
      /^fe[89ab]/.test(lower) || // link-local fe80::/10
      /^ff/.test(lower) // multicast
    );
  }
  return true;
}

function isBlockedV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Throws with a readable message when the URL's host resolves to a refused address. */
export async function assertPublicUrl(url: string): Promise<void> {
  if (privateTargetsAllowed()) return;
  const { protocol, hostname } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error('Only http and https URLs are allowed');
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw new Error(`Refusing to call ${hostname}: it resolves to a private or internal address`);
  }
}
