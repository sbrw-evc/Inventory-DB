/**
 * Small IPv4/IPv6 address and CIDR toolkit. Addresses are held as BigInt so both families share one code path.
 * No dependencies.
 */

export type Family = 4 | 6;

export interface IpAddr {
  family: Family;
  value: bigint;
}

export interface Cidr {
  family: Family;
  /** The address as written (host bits kept), e.g. 10.0.0.5 in 10.0.0.5/24. */
  address: bigint;
  prefixLength: number;
  /** First address of the network (host bits zeroed). */
  network: bigint;
  /** Last address of the network (broadcast for IPv4). */
  last: bigint;
}

export const bitsOf = (family: Family) => (family === 4 ? 32 : 128);
const maxOf = (family: Family) => (1n << BigInt(bitsOf(family))) - 1n;

export function parseIp(text: string): IpAddr | null {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (s.includes(':')) {
    const v = parseV6(s);
    return v == null ? null : { family: 6, value: v };
  }
  const v = parseV4(s);
  return v == null ? null : { family: 4, value: v };
}

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    if (p.length > 1 && p.startsWith('0')) return null; // no octal-looking octets
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseV6(s: string): bigint | null {
  if (s.includes('%')) return null;
  let groups: string[];
  const dbl = s.indexOf('::');
  if (dbl !== s.lastIndexOf('::')) return null;
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  let body = s;
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (v4 == null) return null;
    body = `${s.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  if (dbl >= 0) {
    const [head, tail] = body.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const missing = 8 - h.length - t.length;
    if (missing < 1) return null;
    groups = [...h, ...Array(missing).fill('0'), ...t];
  } else {
    groups = body.split(':');
  }
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

export function formatIp(value: bigint, family: Family): string {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((s) => String((value >> s) & 255n)).join('.');
  }
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  // RFC 5952: compress the longest run (>1) of zero groups, first one on ties.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

export function maskBits(prefixLength: number, family: Family): bigint {
  const bits = bitsOf(family);
  if (prefixLength === 0) return 0n;
  return (maxOf(family) >> BigInt(bits - prefixLength)) << BigInt(bits - prefixLength);
}

export function makeCidr(address: bigint, prefixLength: number, family: Family): Cidr {
  const mask = maskBits(prefixLength, family);
  const network = address & mask;
  const last = network | (maxOf(family) ^ mask);
  return { family, address, prefixLength, network, last };
}

/** Parses `addr/len`. When the length is omitted, a host route (/32 or /128) is assumed if `allowHost`. */
export function parseCidr(text: string, opts: { allowHost?: boolean } = {}): Cidr | null {
  const s = String(text ?? '').trim();
  const slash = s.indexOf('/');
  const ipText = slash >= 0 ? s.slice(0, slash) : s;
  const ip = parseIp(ipText);
  if (!ip) return null;
  let len: number;
  if (slash >= 0) {
    const lt = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(lt)) return null;
    len = Number(lt);
  } else {
    if (!opts.allowHost) return null;
    len = bitsOf(ip.family);
  }
  if (len > bitsOf(ip.family)) return null;
  return makeCidr(ip.value, len, ip.family);
}

/** Network form, e.g. `10.0.0.0/24`. */
export const cidrToString = (c: Cidr) => `${formatIp(c.network, c.family)}/${c.prefixLength}`;
/** Interface form keeping host bits, e.g. `10.0.0.5/24`. */
export const ifaceToString = (c: Cidr) => `${formatIp(c.address, c.family)}/${c.prefixLength}`;

export const size = (c: Pick<Cidr, 'family' | 'prefixLength'>) => 1n << BigInt(bitsOf(c.family) - c.prefixLength);

/** Does `outer` contain `inner` (same family; equal counts as contained)? */
export function contains(outer: Cidr, inner: Cidr | IpAddr): boolean {
  if (outer.family !== inner.family) return false;
  if ('prefixLength' in inner) {
    return inner.prefixLength >= outer.prefixLength && inner.network >= outer.network && inner.last <= outer.last;
  }
  return inner.value >= outer.network && inner.value <= outer.last;
}

export const overlaps = (a: Cidr, b: Cidr) => a.family === b.family && a.network <= b.last && b.network <= a.last;

/** Sort order: family, network, prefix length. */
export function compareCidr(a: Cidr, b: Cidr): number {
  if (a.family !== b.family) return a.family - b.family;
  if (a.network !== b.network) return a.network < b.network ? -1 : 1;
  return a.prefixLength - b.prefixLength;
}

export function compareIp(a: IpAddr, b: IpAddr): number {
  if (a.family !== b.family) return a.family - b.family;
  return a.value === b.value ? 0 : a.value < b.value ? -1 : 1;
}

/** Fixed-width (32 hex digit) key so addresses of one family sort and compare correctly as text in SQL. */
export const hexKey = (v: bigint) => v.toString(16).padStart(32, '0');

/** Splits an inclusive address range into the minimal list of aligned CIDR blocks. */
export function rangeToCidrs(start: bigint, end: bigint, family: Family): Cidr[] {
  const out: Cidr[] = [];
  const bits = bitsOf(family);
  let cur = start;
  while (cur <= end) {
    // largest block aligned at cur
    let len = bits;
    while (len > 0) {
      const candidate = len - 1;
      const blk = 1n << BigInt(bits - candidate);
      if (cur % blk !== 0n || cur + blk - 1n > end) break;
      len = candidate;
    }
    const c = makeCidr(cur, len, family);
    out.push(c);
    cur = c.last + 1n;
  }
  return out;
}

export interface Range {
  start: bigint;
  end: bigint;
}

/** Returns the parts of `[start,end]` not covered by any of `used` (ranges may overlap / be unsorted). */
export function freeRanges(start: bigint, end: bigint, used: Range[]): Range[] {
  const sorted = used.filter((u) => u.end >= start && u.start <= end).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out: Range[] = [];
  let cur = start;
  for (const u of sorted) {
    if (u.start > cur) out.push({ start: cur, end: u.start - 1n < end ? u.start - 1n : end });
    if (u.end + 1n > cur) cur = u.end + 1n;
    if (cur > end) break;
  }
  if (cur <= end) out.push({ start: cur, end });
  return out;
}

/** Hosts usable in a prefix: IPv4 networks larger than /31 exclude network and broadcast unless it is a pool. */
export function usableRange(c: Cidr, isPool = false): Range {
  if (c.family === 4 && !isPool && c.prefixLength < 31) return { start: c.network + 1n, end: c.last - 1n };
  // IPv6: exclude the subnet-router anycast address (first) for non-pool prefixes shorter than /127
  if (c.family === 6 && !isPool && c.prefixLength < 127) return { start: c.network + 1n, end: c.last };
  return { start: c.network, end: c.last };
}

export const familyOf = (text: string): Family | null => parseCidr(text, { allowHost: true })?.family ?? null;
