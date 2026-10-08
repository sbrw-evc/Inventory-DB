import { describe, expect, it } from 'vitest';
import {
  cidrToString,
  compareCidr,
  contains,
  formatIp,
  freeRanges,
  ifaceToString,
  parseCidr,
  parseIp,
  rangeToCidrs,
  size,
  usableRange,
} from '../src/netbox/cidr.js';

describe('cidr utils', () => {
  it('parses and formats IPv4', () => {
    expect(parseIp('10.1.2.3')).toEqual({ family: 4, value: 0x0a010203n });
    expect(parseIp('256.1.1.1')).toBeNull();
    expect(parseIp('1.2.3')).toBeNull();
    expect(parseIp('01.2.3.4')).toBeNull();
    expect(formatIp(0xc0a80001n, 4)).toBe('192.168.0.1');
  });

  it('parses and formats IPv6 with compression', () => {
    expect(formatIp(parseIp('2001:0db8:0000:0000:0000:0000:0000:0001')!.value, 6)).toBe('2001:db8::1');
    expect(formatIp(parseIp('::')!.value, 6)).toBe('::');
    expect(formatIp(parseIp('::1')!.value, 6)).toBe('::1');
    expect(formatIp(parseIp('fe80::')!.value, 6)).toBe('fe80::');
    expect(formatIp(parseIp('2001:db8:0:1:0:0:0:1')!.value, 6)).toBe('2001:db8:0:1::1');
    expect(formatIp(parseIp('2001:db8:1:1:1:1:1:1')!.value, 6)).toBe('2001:db8:1:1:1:1:1:1');
    expect(parseIp('::ffff:10.0.0.1')!.value).toBe(0xffff0a000001n);
    expect(parseIp('1::2::3')).toBeNull();
    expect(parseIp('12345::')).toBeNull();
  });

  it('parses prefixes, network and last address', () => {
    const c = parseCidr('10.0.0.77/24')!;
    expect(cidrToString(c)).toBe('10.0.0.0/24');
    expect(ifaceToString(c)).toBe('10.0.0.77/24');
    expect(formatIp(c.last, 4)).toBe('10.0.0.255');
    expect(size(c)).toBe(256n);
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('10.0.0.1')).toBeNull();
    expect(cidrToString(parseCidr('10.0.0.1', { allowHost: true })!)).toBe('10.0.0.1/32');
    const v6 = parseCidr('2001:db8::1/64')!;
    expect(cidrToString(v6)).toBe('2001:db8::/64');
    expect(formatIp(v6.last, 6)).toBe('2001:db8::ffff:ffff:ffff:ffff');
    expect(size(v6)).toBe(1n << 64n);
  });

  it('contains and compares', () => {
    const outer = parseCidr('10.0.0.0/16')!;
    expect(contains(outer, parseCidr('10.0.5.0/24')!)).toBe(true);
    expect(contains(outer, parseCidr('10.1.0.0/24')!)).toBe(false);
    expect(contains(outer, parseIp('10.0.255.255')!)).toBe(true);
    expect(contains(outer, parseIp('::1')!)).toBe(false);
    const list = ['10.0.1.0/24', '10.0.0.0/16', '2001:db8::/32', '10.0.0.0/24'].map((s) => parseCidr(s)!);
    expect(list.sort(compareCidr).map(cidrToString)).toEqual(['10.0.0.0/16', '10.0.0.0/24', '10.0.1.0/24', '2001:db8::/32']);
  });

  it('splits ranges into CIDR blocks and finds free space', () => {
    const p = parseCidr('10.0.0.0/24')!;
    const free = freeRanges(p.network, p.last, [
      { start: parseIp('10.0.0.0')!.value, end: parseIp('10.0.0.63')!.value },
      { start: parseIp('10.0.0.128')!.value, end: parseIp('10.0.0.191')!.value },
    ]);
    const blocks = free.flatMap((r) => rangeToCidrs(r.start, r.end, 4)).map(cidrToString);
    expect(blocks).toEqual(['10.0.0.64/26', '10.0.0.192/26']);
    expect(rangeToCidrs(parseIp('10.0.0.1')!.value, parseIp('10.0.0.6')!.value, 4).map(cidrToString)).toEqual([
      '10.0.0.1/32',
      '10.0.0.2/31',
      '10.0.0.4/31',
      '10.0.0.6/32',
    ]);
    const v6 = parseCidr('2001:db8::/48')!;
    const v6free = freeRanges(v6.network, v6.last, [{ start: v6.network, end: parseCidr('2001:db8::/64')!.last }]);
    expect(rangeToCidrs(v6free[0].start, v6free[0].end, 6).map(cidrToString).slice(0, 2)).toEqual(['2001:db8:0:1::/64', '2001:db8:0:2::/63']);
  });

  it('usable range excludes network/broadcast for IPv4 LANs', () => {
    const r = usableRange(parseCidr('192.168.1.0/30')!);
    expect([formatIp(r.start, 4), formatIp(r.end, 4)]).toEqual(['192.168.1.1', '192.168.1.2']);
    const p2p = usableRange(parseCidr('192.168.1.0/31')!);
    expect([formatIp(p2p.start, 4), formatIp(p2p.end, 4)]).toEqual(['192.168.1.0', '192.168.1.1']);
    const pool = usableRange(parseCidr('192.168.1.0/30')!, true);
    expect(formatIp(pool.start, 4)).toBe('192.168.1.0');
  });
});
