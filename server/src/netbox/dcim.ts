/** DCIM helpers: rack placement/elevation and cable paths. */
import { addError } from './models/common.js';
import type { Ctx, Errors, Obj, Row } from './types.js';

export type Face = 'front' | 'rear';

export interface Placement {
  device_id: number;
  position: number;
  u_height: number;
  faces: Face[];
}

export function deviceDims(ctx: Ctx, device: Row): { u_height: number; is_full_depth: boolean } {
  const dt = ctx.get('dcim.devicetype', device.device_type_id);
  return { u_height: dt ? Number(dt.u_height) : 1, is_full_depth: dt ? !!dt.is_full_depth : true };
}

const facesOf = (face: Face | null, fullDepth: boolean): Face[] => (fullDepth ? ['front', 'rear'] : face ? [face] : ['front']);

/** Devices mounted in a rack (with a position), excluding one device id. */
export function rackPlacements(ctx: Ctx, rackId: number, excludeId?: number | null): Placement[] {
  const rows = ctx.db
    .prepare('SELECT * FROM nb_devices WHERE rack_id = ? AND position IS NOT NULL AND id IS NOT ?')
    .all(rackId, excludeId ?? null) as Row[];
  return rows.map((d) => {
    const dims = deviceDims(ctx, d);
    return { device_id: d.id, position: d.position, u_height: dims.u_height, faces: facesOf(d.face, dims.is_full_depth) };
  });
}

/** Validates a device's rack position: fits the rack and doesn't overlap another device on the same face. */
export function checkPlacement(ctx: Ctx, rec: Row, errors: Errors, dimsOverride?: { u_height: number; is_full_depth: boolean }) {
  if (rec.position == null) return;
  if (rec.rack_id == null) {
    addError(errors, 'position', 'Cannot set a rack position without a rack.');
    return;
  }
  if (rec.face == null) addError(errors, 'face', 'Must specify the rack face when setting a rack position.');
  const rack = ctx.get('dcim.rack', rec.rack_id);
  if (!rack) return;
  const dims = dimsOverride ?? deviceDims(ctx, rec);
  if (dims.u_height === 0) {
    addError(errors, 'position', 'A 0U device type cannot be assigned to a rack position.');
    return;
  }
  const top = rec.position + dims.u_height - 1;
  if (rec.position < 1 || top > rack.u_height) {
    addError(errors, 'position', `U${rec.position} is outside the rack: a ${dims.u_height}U device needs units ${rec.position}-${top}, the rack has ${rack.u_height}U.`);
    return;
  }
  const faces = facesOf(rec.face, dims.is_full_depth);
  for (const p of rackPlacements(ctx, rec.rack_id, rec.id)) {
    const pTop = p.position + p.u_height - 1;
    if (p.u_height === 0 || pTop < rec.position || p.position > top) continue;
    if (!p.faces.some((f) => faces.includes(f))) continue;
    const other = ctx.get('dcim.device', p.device_id);
    addError(errors, 'position', `U${rec.position} is already occupied or does not have sufficient space to accommodate this device (conflicts with ${other?.name ?? `device ${p.device_id}`} at U${p.position}-${pTop}).`);
    return;
  }
}

/** Rack units top-down (or bottom-up for desc_units) with the device occupying each on the given face. */
export function rackElevation(ctx: Ctx, rack: Row, face: Face): Obj[] {
  const byUnit = new Map<number, Placement>();
  for (const p of rackPlacements(ctx, rack.id)) {
    if (!p.faces.includes(face)) continue;
    for (let u = p.position; u < p.position + p.u_height; u++) byUnit.set(u, p);
  }
  const units: Obj[] = [];
  for (let i = 0; i < rack.u_height; i++) {
    const u = rack.desc_units ? i + 1 : rack.u_height - i;
    const p = byUnit.get(u);
    let device: Obj | null = null;
    if (p) {
      const d = ctx.get('dcim.device', p.device_id)!;
      const role = ctx.get('dcim.devicerole', d.role_id);
      device = {
        ...ctx.ref('dcim.device', d.id),
        position: p.position,
        u_height: p.u_height,
        face: d.face,
        is_full_depth: p.faces.length === 2,
        role: ctx.ref('dcim.devicerole', d.role_id),
        role_color: role?.color ?? '9e9e9e',
        status: d.status,
      };
    }
    units.push({ id: u, name: `U${u}`, face: { value: face, label: face === 'front' ? 'Front' : 'Rear' }, device, occupied: !!p, display: `U${u}` });
  }
  return units;
}

export const ifaceTermination = (ctx: Ctx, id: number): Obj => ({
  object_type: 'dcim.interface',
  object_id: id,
  object: ctx.ref('dcim.interface', id),
});

/** Interfaces on the far side of an interface's cable. */
export function linkPeers(ctx: Ctx, iface: Row): Row[] {
  if (iface.cable_id == null) return [];
  return ctx.db
    .prepare('SELECT * FROM nb_interfaces WHERE cable_id = ? AND cable_end IS NOT ? ORDER BY id')
    .all(iface.cable_id, iface.cable_end) as Row[];
}

/**
 * Cable path from an interface: a list of segments `[near_end[], cable, far_end[]]`, NetBox style.
 * Only interfaces terminate cables here (no front/rear pass-through ports), so a path has one segment.
 */
export function traceInterface(ctx: Ctx, iface: Row): unknown[] {
  if (iface.cable_id == null) return [];
  const near = ctx.db.prepare('SELECT id FROM nb_interfaces WHERE cable_id = ? AND cable_end = ? ORDER BY id').all(iface.cable_id, iface.cable_end) as Row[];
  const far = linkPeers(ctx, iface);
  const cable = ctx.get('dcim.cable', iface.cable_id);
  return [[near.map((r) => ctx.serialize('dcim.interface', ctx.get('dcim.interface', r.id)!)), cable ? ctx.serialize('dcim.cable', cable) : null, far.map((r) => ctx.serialize('dcim.interface', r))]];
}

export const INTERFACE_TYPES = [
  ['virtual', 'Virtual'],
  ['bridge', 'Bridge'],
  ['lag', 'Link Aggregation Group (LAG)'],
  ['100base-tx', '100BASE-TX (10/100ME)'],
  ['1000base-t', '1000BASE-T (1GE)'],
  ['2.5gbase-t', '2.5GBASE-T (2.5GE)'],
  ['5gbase-t', '5GBASE-T (5GE)'],
  ['10gbase-t', '10GBASE-T (10GE)'],
  ['1000base-x-sfp', 'SFP (1GE)'],
  ['10gbase-x-sfpp', 'SFP+ (10GE)'],
  ['25gbase-x-sfp28', 'SFP28 (25GE)'],
  ['40gbase-x-qsfpp', 'QSFP+ (40GE)'],
  ['100gbase-x-qsfp28', 'QSFP28 (100GE)'],
  ['400gbase-x-qsfpdd', 'QSFP-DD (400GE)'],
  ['ieee802.11ac', 'IEEE 802.11ac'],
  ['ieee802.11ax', 'IEEE 802.11ax'],
  ['other', 'Other'],
] as const;

/** Interface types that can't take a cable. */
export const VIRTUAL_IFACE_TYPES = new Set(['virtual', 'bridge', 'lag']);
