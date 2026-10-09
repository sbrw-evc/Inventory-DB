/** Power calculations: feed capacity, port draw (through PDU outlets) and rack utilisation, as in NetBox. */
import { linkPeers } from './cabling.js';
import type { Ctx, Obj, Row } from './types.js';

/** Usable power of a feed in VA: voltage × amperage × max_utilization%, × √3 for three-phase AC. */
export function feedAvailablePower(feed: Row): number {
  const v = Math.abs(Number(feed.voltage ?? 0));
  const a = Number(feed.amperage ?? 0);
  const pct = Number(feed.max_utilization ?? 100) / 100;
  const kva = v * a * pct;
  return Math.round(feed.phase === 'three-phase' && feed.supply !== 'dc' ? kva * Math.sqrt(3) : kva);
}

export interface PowerDraw {
  allocated: number;
  maximum: number;
  outlet_count: number;
  connected: number;
}

/**
 * Draw of a power port. A port that feeds outlets (a PDU inlet) draws what the ports plugged into those outlets
 * draw; any other port draws its own `allocated_draw` / `maximum_draw`.
 */
export function powerPortDraw(ctx: Ctx, port: Row): PowerDraw {
  const outlets = ctx.db.prepare('SELECT * FROM nb_power_outlets WHERE power_port_id = ?').all(port.id) as Row[];
  if (!outlets.length) return { allocated: Number(port.allocated_draw ?? 0), maximum: Number(port.maximum_draw ?? 0), outlet_count: 0, connected: 0 };
  let allocated = 0;
  let maximum = 0;
  let connected = 0;
  for (const o of outlets) {
    for (const p of linkPeers(ctx, o)) {
      if (p.type !== 'dcim.powerport') continue;
      connected++;
      allocated += Number(p.row.allocated_draw ?? 0);
      maximum += Number(p.row.maximum_draw ?? 0);
    }
  }
  return { allocated, maximum, outlet_count: outlets.length, connected };
}

/** Load on a feed: the draw of the power ports cabled to it. */
export function feedLoad(ctx: Ctx, feed: Row): { allocated: number; maximum: number } {
  let allocated = 0;
  let maximum = 0;
  for (const p of linkPeers(ctx, feed)) {
    if (p.type !== 'dcim.powerport') continue;
    const d = powerPortDraw(ctx, p.row);
    allocated += d.allocated;
    maximum += d.maximum;
  }
  return { allocated, maximum };
}

const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 1000) / 10 : 0);

export function feedUtilization(ctx: Ctx, feed: Row): number {
  return pct(feedLoad(ctx, feed).allocated, feedAvailablePower(feed));
}

/** Rack power summary: each feed's capacity and load, totals, and the allocated draw of the rack's devices. */
export function rackPower(ctx: Ctx, rackId: number): Obj {
  const feeds = ctx.db.prepare('SELECT * FROM nb_power_feeds WHERE rack_id = ? ORDER BY name, id').all(rackId) as Row[];
  let available = 0;
  let allocated = 0;
  let maximum = 0;
  const rows = feeds.map((f) => {
    const cap = feedAvailablePower(f);
    const load = feedLoad(ctx, f);
    available += cap;
    allocated += load.allocated;
    maximum += load.maximum;
    return {
      feed: ctx.ref('dcim.powerfeed', f.id),
      status: f.status,
      type: f.type,
      available_power: cap,
      allocated_draw: load.allocated,
      maximum_draw: load.maximum,
      utilization: pct(load.allocated, cap),
    };
  });
  // Ports of devices in the rack that don't feed outlets (end consumers), connected or not.
  const dev = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(p.allocated_draw), 0) a, COALESCE(SUM(p.maximum_draw), 0) m, COUNT(*) n FROM nb_power_ports p JOIN nb_devices d ON d.id = p.device_id
       WHERE d.rack_id = ? AND NOT EXISTS (SELECT 1 FROM nb_power_outlets o WHERE o.power_port_id = p.id)`,
    )
    .get(rackId) as { a: number; m: number; n: number };
  return {
    feeds: rows,
    available_power: available,
    allocated_draw: allocated,
    maximum_draw: maximum,
    utilization: pct(allocated, available),
    device_power_ports: dev.n,
    device_allocated_draw: dev.a,
    device_maximum_draw: dev.m,
  };
}

/** NetBox's Rack.get_power_utilization(): allocated draw on the rack's feeds / their available power, in %. */
export function rackPowerUtilization(ctx: Ctx, rackId: number): number {
  const feeds = ctx.db.prepare('SELECT * FROM nb_power_feeds WHERE rack_id = ?').all(rackId) as Row[];
  const available = feeds.reduce((s, f) => s + feedAvailablePower(f), 0);
  if (!available) return 0;
  return pct(
    feeds.reduce((s, f) => s + feedLoad(ctx, f).allocated, 0),
    available,
  );
}
