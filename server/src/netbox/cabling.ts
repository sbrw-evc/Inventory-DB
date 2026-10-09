/**
 * Cables and cable paths. A cable joins terminations on side A and side B; terminations are rows of the tables
 * below with `cable_id` / `cable_end` columns. Front ports, rear ports and circuit terminations pass a path on
 * (front → rear by position, rear → front by the position stack, circuit termination A ↔ Z), so a trace from an
 * interface can cross patch panels and circuits, NetBox style.
 */
import { q } from '../db/index.js';
import { addError } from './models/common.js';
import type { Ctx, Errors, Obj, Row } from './types.js';

export interface TermType {
  table: string;
  /** Field holding the parent object (device, circuit, power panel). */
  parent: string;
  parentType: string;
  /** Types this one may be cabled to. */
  compatible: string[];
}

const DATA = ['dcim.interface', 'dcim.frontport', 'dcim.rearport', 'circuits.circuittermination'];

export const TERMINATION_TYPES: Record<string, TermType> = {
  'dcim.interface': { table: 'nb_interfaces', parent: 'device', parentType: 'dcim.device', compatible: DATA },
  'dcim.frontport': { table: 'nb_front_ports', parent: 'device', parentType: 'dcim.device', compatible: DATA },
  'dcim.rearport': { table: 'nb_rear_ports', parent: 'device', parentType: 'dcim.device', compatible: DATA },
  'circuits.circuittermination': { table: 'nb_circuit_terminations', parent: 'circuit', parentType: 'circuits.circuit', compatible: DATA },
  'dcim.powerport': { table: 'nb_power_ports', parent: 'device', parentType: 'dcim.device', compatible: ['dcim.poweroutlet', 'dcim.powerfeed'] },
  'dcim.poweroutlet': { table: 'nb_power_outlets', parent: 'device', parentType: 'dcim.device', compatible: ['dcim.powerport'] },
  'dcim.powerfeed': { table: 'nb_power_feeds', parent: 'power_panel', parentType: 'dcim.powerpanel', compatible: ['dcim.powerport'] },
};

/** Types a path passes through rather than ends at. */
export const PASS_THROUGH = new Set(['dcim.frontport', 'dcim.rearport', 'circuits.circuittermination']);

/** Interface types that can't take a cable. */
export const VIRTUAL_IFACE_TYPES = new Set(['virtual', 'bridge', 'lag']);

export interface Node {
  type: string;
  row: Row;
}

export const termObj = (ctx: Ctx, type: string, id: number): Obj => ({ object_type: type, object_id: id, object: ctx.ref(type, id) });

/** All terminations of a cable, ordered by type then id. */
export function cableEnds(ctx: Ctx, cableId: number): (Node & { end: 'A' | 'B' })[] {
  const out: (Node & { end: 'A' | 'B' })[] = [];
  for (const [type, t] of Object.entries(TERMINATION_TYPES)) {
    const rows = ctx.db.prepare(`SELECT * FROM ${q(t.table)} WHERE cable_id = ? ORDER BY id`).all(cableId) as Row[];
    for (const row of rows) out.push({ type, row, end: row.cable_end });
  }
  return out;
}

/** Terminations on the far side of a termination's cable. */
export function linkPeers(ctx: Ctx, row: Row): Node[] {
  if (row.cable_id == null) return [];
  return cableEnds(ctx, row.cable_id).filter((e) => e.end !== row.cable_end);
}

export function clearCableEnds(ctx: Ctx, cableId: number, end?: 'A' | 'B') {
  for (const t of Object.values(TERMINATION_TYPES)) {
    if (end) ctx.db.prepare(`UPDATE ${q(t.table)} SET cable_id = NULL, cable_end = NULL WHERE cable_id = ? AND cable_end = ?`).run(cableId, end);
    else ctx.db.prepare(`UPDATE ${q(t.table)} SET cable_id = NULL, cable_end = NULL WHERE cable_id = ?`).run(cableId);
  }
  ctx.invalidate();
}

export function setCableEnds(ctx: Ctx, cableId: number, end: 'A' | 'B', nodes: { type: string; id: number }[]) {
  clearCableEnds(ctx, cableId, end);
  for (const n of nodes) ctx.db.prepare(`UPDATE ${q(TERMINATION_TYPES[n.type].table)} SET cable_id = ?, cable_end = ? WHERE id = ?`).run(cableId, end, n.id);
  ctx.invalidate();
}

const parentName = (ctx: Ctx, type: string, row: Row) => {
  const t = TERMINATION_TYPES[type];
  const p = ctx.get(t.parentType, row[`${t.parent}_id`]);
  return p ? `${p.name ?? p.cid ?? ''} ` : '';
};

/** Parses `a_terminations` / `b_terminations` (`[{object_type, object_id}]`, bare ids mean interfaces). */
export function parseTerminations(ctx: Ctx, raw: unknown, key: string, errors: Errors): { type: string; id: number }[] {
  if (!Array.isArray(raw)) {
    addError(errors, key, 'Provide a list of terminations, e.g. [{"object_type": "dcim.interface", "object_id": 1}].');
    return [];
  }
  const out: { type: string; id: number }[] = [];
  for (const item of raw) {
    let id: unknown = item;
    let type = 'dcim.interface';
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      type = String(o.object_type ?? 'dcim.interface');
      id = o.object_id ?? o.id;
    }
    if (!TERMINATION_TYPES[type]) {
      addError(errors, key, `Unsupported termination type "${type}" (one of ${Object.keys(TERMINATION_TYPES).join(', ')}).`);
      continue;
    }
    const n = Number(id);
    const row = Number.isInteger(n) ? ctx.get(type, n) : null;
    if (!row) {
      addError(errors, key, `${type} ${String(id)} not found.`);
      continue;
    }
    if (type === 'dcim.interface' && VIRTUAL_IFACE_TYPES.has(row.type)) addError(errors, key, `Cables cannot be attached to ${row.type} interfaces (${row.name}).`);
    if (type === 'circuits.circuittermination' && row.provider_network_id != null) addError(errors, key, 'Cannot connect a cable to a circuit termination attached to a provider network.');
    if (!out.some((x) => x.type === type && x.id === n)) out.push({ type, id: n });
  }
  return out;
}

/** Validates both sides of a cable (types, compatibility, parents, free terminations). */
export function validateCableSides(ctx: Ctx, cableId: number | null, sides: Record<'a' | 'b', { type: string; id: number }[] | null>, errors: Errors) {
  for (const side of ['a', 'b'] as const) {
    const items = sides[side];
    if (!items) continue;
    const key = `${side}_terminations`;
    if (items.length === 0) {
      if (!errors[key]) addError(errors, key, 'At least one termination is required.');
      continue;
    }
    const types = new Set(items.map((i) => i.type));
    if (types.size > 1) addError(errors, key, `All terminations on side ${side.toUpperCase()} must be of the same type.`);
    const first = items[0];
    const t = TERMINATION_TYPES[first.type];
    const parents = new Set(items.map((i) => ctx.get(i.type, i.id)?.[`${TERMINATION_TYPES[i.type].parent}_id`]));
    if (parents.size > 1) addError(errors, key, `All terminations on side ${side.toUpperCase()} must belong to the same ${t.parent.replace('_', ' ')}.`);
    for (const i of items) {
      const row = ctx.get(i.type, i.id)!;
      if (row.cable_id != null && row.cable_id !== cableId) addError(errors, key, `${parentName(ctx, i.type, row)}${row.name ?? row.term_side ?? row.id} already has a cable (#${row.cable_id}).`);
    }
  }
  const a = sides.a;
  const b = sides.b;
  if (a?.length && b?.length) {
    if (a.some((x) => b.some((y) => y.type === x.type && y.id === x.id))) addError(errors, 'b_terminations', 'A termination cannot be on both ends of a cable.');
    const ta = a[0].type;
    const tb = b[0].type;
    if (!TERMINATION_TYPES[ta].compatible.includes(tb)) addError(errors, 'b_terminations', `Incompatible termination types: ${ta} and ${tb}.`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Paths

export interface Hop {
  near: Node[];
  cable: Row | null;
  far: Node[];
}

/** Next near ends after passing through `far`, or null when the path ends there. */
function passThrough(ctx: Ctx, far: Node[], stack: number[]): Node[] | null {
  if (!far.length || !far.every((n) => n.type === far[0].type) || !PASS_THROUGH.has(far[0].type)) return null;
  const type = far[0].type;
  if (type === 'dcim.frontport') {
    const out: Node[] = [];
    for (const f of far) {
      const rear = ctx.get('dcim.rearport', f.row.rear_port_id);
      if (!rear || out.some((n) => n.row.id === rear.id)) continue;
      if (rear.positions > 1) stack.push(f.row.rear_port_position);
      out.push({ type: 'dcim.rearport', row: rear });
    }
    return out.length ? out : null;
  }
  if (type === 'dcim.rearport') {
    const out: Node[] = [];
    for (const r of far) {
      let rows: Row[];
      if (r.row.positions > 1) {
        const pos = stack.pop();
        if (pos == null) return null; // path splits into every position; NetBox stops here too
        rows = ctx.db.prepare('SELECT * FROM nb_front_ports WHERE rear_port_id = ? AND rear_port_position = ?').all(r.row.id, pos) as Row[];
      } else {
        rows = ctx.db.prepare('SELECT * FROM nb_front_ports WHERE rear_port_id = ? ORDER BY id').all(r.row.id) as Row[];
      }
      out.push(...rows.map((row) => ({ type: 'dcim.frontport', row })));
    }
    return out.length ? out : null;
  }
  // circuit termination → the other side of the circuit
  const out: Node[] = [];
  for (const ct of far) {
    const peer = ctx.db.prepare('SELECT * FROM nb_circuit_terminations WHERE circuit_id = ? AND term_side != ?').get(ct.row.circuit_id, ct.row.term_side) as Row | undefined;
    if (peer) out.push({ type: 'circuits.circuittermination', row: peer });
  }
  return out.length ? out : null;
}

/**
 * Cable path from a termination: hops of `{near, cable, far}`. A pass-through far end continues the path; a path
 * ending on an uncabled pass-through port gets a last hop with `cable: null`.
 */
export function tracePath(ctx: Ctx, type: string, row: Row): Hop[] {
  const hops: Hop[] = [];
  const stack: number[] = [];
  const seen = new Set<number>();
  let near: Node[] = [{ type, row }];
  for (let i = 0; i < 64; i++) {
    const cableId = near[0].row.cable_id;
    if (cableId == null) {
      if (hops.length) hops.push({ near, cable: null, far: [] });
      break;
    }
    if (seen.has(cableId)) break;
    seen.add(cableId);
    const end = near[0].row.cable_end;
    const ends = cableEnds(ctx, cableId);
    const nearAll = ends.filter((e) => e.end === end).map(({ type: t, row: r }) => ({ type: t, row: r }));
    const far = ends.filter((e) => e.end !== end).map(({ type: t, row: r }) => ({ type: t, row: r }));
    hops.push({ near: nearAll.length ? nearAll : near, cable: ctx.get('dcim.cable', cableId), far });
    const next = passThrough(ctx, far, stack);
    if (!next) break;
    near = next;
  }
  return hops;
}

/** NetBox trace output: `[[near_ends[], cable, far_ends[]], …]` with full serialized objects. */
export function serializeTrace(ctx: Ctx, hops: Hop[]): unknown[] {
  return hops.map((h) => [
    h.near.map((n) => ctx.serialize(n.type, ctx.get(n.type, n.row.id)!)),
    h.cable ? ctx.serialize('dcim.cable', h.cable) : null,
    h.far.map((n) => ctx.serialize(n.type, ctx.get(n.type, n.row.id)!)),
  ]);
}

/** link_peers / connected_endpoints fields shared by every cable termination. */
export function connectionFields(ctx: Ctx, type: string, row: Row): Obj {
  const peers = linkPeers(ctx, row);
  let endpoints: Node[] = [];
  let reachable: boolean | null = null;
  if (peers.length) {
    const hops = tracePath(ctx, type, row);
    const last = hops[hops.length - 1];
    if (last && last.far.length && !PASS_THROUGH.has(last.far[0].type)) {
      endpoints = last.far;
      reachable = hops.every((h) => h.cable?.status === 'connected');
    }
  }
  return {
    link_peers: peers.map((p) => ctx.ref(p.type, p.row.id)),
    link_peers_type: peers[0]?.type ?? null,
    connected_endpoints: endpoints.length ? endpoints.map((p) => ctx.ref(p.type, p.row.id)) : null,
    connected_endpoints_type: endpoints[0]?.type ?? null,
    connected_endpoints_reachable: endpoints.length ? reachable : null,
    _occupied: row.cable_id != null || !!row.mark_connected,
  };
}
