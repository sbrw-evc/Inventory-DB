/** IPAM helpers: prefix hierarchy, utilisation and next-available allocation. */
import { cidrToString, formatIp, freeRanges, hexKey, makeCidr, parseCidr, rangeToCidrs, size, usableRange, type Cidr, type Family, type Range } from './cidr.js';
import type { Ctx, Row, SqlFrag } from './types.js';

export const familyObj = (f: number | null | undefined) => (f == null ? null : { value: f, label: `IPv${f}` });

export const prefixCidr = (r: Row): Cidr => parseCidr(r.prefix)!;

const big = (hex: string) => BigInt(`0x${hex}`);

/**
 * Scope for objects (alias `c`) that are children of prefix `p`: same family, inside its range, and in the same
 * VRF — except that a global (no VRF) container prefix spans every VRF, as in NetBox.
 */
function scope(p: Row, alias: string, startCol: string, endCol: string): SqlFrag {
  const vrfAll = p.vrf_id == null && p.status === 'container';
  return {
    sql: `${alias}.family = ? AND ${alias}.${startCol} >= ? AND ${alias}.${endCol} <= ?${vrfAll ? '' : ` AND ${alias}.vrf_id IS ?`}`,
    params: vrfAll ? [p.family, p.start_hex, p.end_hex] : [p.family, p.start_hex, p.end_hex, p.vrf_id],
  };
}

export function childPrefixRows(ctx: Ctx, p: Row): Row[] {
  const s = scope(p, 'c', 'start_hex', 'end_hex');
  return ctx.db
    .prepare(`SELECT * FROM nb_prefixes c WHERE ${s.sql} AND c.prefix_length > ? ORDER BY c.start_hex, c.prefix_length`)
    .all(...s.params, p.prefix_length) as Row[];
}

function childIpRanges(ctx: Ctx, p: Row, start: string, end: string, onlyFlag?: 'mark_populated' | 'mark_utilized'): Range[] {
  const vrfAll = p.vrf_id == null && p.status === 'container';
  const rows = ctx.db
    .prepare(
      `SELECT start_hex, end_hex FROM nb_ip_ranges c WHERE c.family = ? AND c.start_hex >= ? AND c.end_hex <= ?${vrfAll ? '' : ' AND c.vrf_id IS ?'}${onlyFlag ? ` AND c.${onlyFlag} = 1` : ''}`,
    )
    .all(...(vrfAll ? [p.family, start, end] : [p.family, start, end, p.vrf_id])) as Row[];
  return rows.map((r) => ({ start: big(r.start_hex), end: big(r.end_hex) }));
}

function childIpHosts(ctx: Ctx, p: Row, start: string, end: string): bigint[] {
  const vrfAll = p.vrf_id == null && p.status === 'container';
  const rows = ctx.db
    .prepare(`SELECT DISTINCT host_hex FROM nb_ip_addresses c WHERE c.family = ? AND c.host_hex >= ? AND c.host_hex <= ?${vrfAll ? '' : ' AND c.vrf_id IS ?'}`)
    .all(...(vrfAll ? [p.family, start, end] : [p.family, start, end, p.vrf_id])) as Row[];
  return rows.map((r) => big(r.host_hex));
}

/** Number of strict parents in the same VRF. */
export function prefixDepth(ctx: Ctx, p: Row): number {
  return (
    ctx.db
      .prepare('SELECT COUNT(*) n FROM nb_prefixes c WHERE c.family = ? AND c.vrf_id IS ? AND c.start_hex <= ? AND c.end_hex >= ? AND c.prefix_length < ?')
      .get(p.family, p.vrf_id, p.start_hex, p.end_hex, p.prefix_length) as { n: number }
  ).n;
}

/** Number of strict children in the same VRF. */
export function prefixChildren(ctx: Ctx, p: Row): number {
  return (
    ctx.db
      .prepare('SELECT COUNT(*) n FROM nb_prefixes c WHERE c.family = ? AND c.vrf_id IS ? AND c.start_hex >= ? AND c.end_hex <= ? AND c.prefix_length > ?')
      .get(p.family, p.vrf_id, p.start_hex, p.end_hex, p.prefix_length) as { n: number }
  ).n;
}

const pct = (used: bigint, total: bigint) => {
  if (total <= 0n) return 0;
  const v = Number((used * 10000n) / total) / 100;
  return Math.min(100, Math.round(v * 10) / 10);
};

/** Covered address count of a set of (possibly overlapping) ranges within [start, end]. */
function covered(start: bigint, end: bigint, used: Range[]): bigint {
  const free = freeRanges(start, end, used).reduce((n, r) => n + (r.end - r.start + 1n), 0n);
  return end - start + 1n - free;
}

/** Utilisation in percent. Containers count child prefixes; others count IPs plus utilised ranges. */
export function prefixUtilization(ctx: Ctx, p: Row): number {
  if (p.mark_utilized) return 100;
  const c = prefixCidr(p);
  if (p.status === 'container') {
    const used = childPrefixRows(ctx, p).map((r) => ({ start: big(r.start_hex), end: big(r.end_hex) }));
    return pct(covered(c.network, c.last, used), size(c));
  }
  const hosts = childIpHosts(ctx, p, p.start_hex, p.end_hex).map((h) => ({ start: h, end: h }));
  const ranges = childIpRanges(ctx, p, p.start_hex, p.end_hex, 'mark_utilized');
  const usable = usableRange(c, !!p.is_pool);
  const total = usable.end >= usable.start ? usable.end - usable.start + 1n : 0n;
  return pct(covered(usable.start, usable.end, [...hosts, ...ranges]), total);
}

/** Utilisation of an aggregate: global child prefixes. */
export function aggregateUtilization(ctx: Ctx, a: Row): number {
  const rows = ctx.db
    .prepare('SELECT start_hex, end_hex FROM nb_prefixes WHERE family = ? AND start_hex >= ? AND end_hex <= ? AND vrf_id IS NULL')
    .all(a.family, a.start_hex, a.end_hex) as Row[];
  const c = parseCidr(a.prefix)!;
  return pct(covered(c.network, c.last, rows.map((r) => ({ start: big(r.start_hex), end: big(r.end_hex) }))), size(c));
}

/** Free space in a prefix as aligned CIDR blocks. */
export function availablePrefixes(ctx: Ctx, p: Row): Cidr[] {
  const c = prefixCidr(p);
  const used = childPrefixRows(ctx, p).map((r) => ({ start: big(r.start_hex), end: big(r.end_hex) }));
  return freeRanges(c.network, c.last, used).flatMap((r) => rangeToCidrs(r.start, r.end, c.family));
}

/** First free block of the given length inside a prefix, skipping `taken` blocks allocated in the same request. */
export function nextAvailablePrefix(ctx: Ctx, p: Row, length: number, taken: Cidr[] = []): Cidr | null {
  const c = prefixCidr(p);
  if (length < c.prefixLength || length > (c.family === 4 ? 32 : 128)) return null;
  const used = [
    ...childPrefixRows(ctx, p).map((r) => ({ start: big(r.start_hex), end: big(r.end_hex) })),
    ...taken.map((t) => ({ start: t.network, end: t.last })),
  ];
  for (const free of freeRanges(c.network, c.last, used)) {
    for (const blk of rangeToCidrs(free.start, free.end, c.family)) {
      if (blk.prefixLength <= length) return makeCidr(blk.network, length, c.family);
    }
  }
  return null;
}

/** Free host addresses (up to `limit`) inside a prefix or an explicit range. */
export function availableIps(ctx: Ctx, p: Row, limit: number, range?: Range): bigint[] {
  const c = prefixCidr(p);
  const area = range ?? usableRange(c, !!p.is_pool);
  const startHex = hexKey(area.start);
  const endHex = hexKey(area.end);
  const used: Range[] = childIpHosts(ctx, p, startHex, endHex).map((h) => ({ start: h, end: h }));
  if (!range) used.push(...childIpRanges(ctx, p, p.start_hex, p.end_hex, 'mark_populated'));
  const out: bigint[] = [];
  for (const free of freeRanges(area.start, area.end, used)) {
    for (let v = free.start; v <= free.end && out.length < limit; v++) out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

export const formatPrefix = cidrToString;
export const formatAddress = (v: bigint, family: Family, len: number) => `${formatIp(v, family)}/${len}`;
