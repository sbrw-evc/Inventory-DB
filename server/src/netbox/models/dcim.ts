import { checkPlacement, ifaceTermination, INTERFACE_TYPES, linkPeers, rackPlacements, VIRTUAL_IFACE_TYPES, deviceDims } from '../dcim.js';
import type { Ctx, Errors, ModelDef, Row, SqlFrag } from '../types.js';
import { choices } from '../types.js';
import { addError, checkTreeCycle, colorF, commentsF, count, descriptionF, nameF, slugF, tenantF, treeDepth } from './common.js';

const SITE_STATUS = choices('planned', 'staging', 'active', 'decommissioning', 'retired');
const RACK_STATUS = choices('reserved', 'available', 'planned', 'active', 'deprecated');
const DEVICE_STATUS = choices('offline', 'active', 'planned', 'staged', 'failed', 'inventory', 'decommissioning');
const CABLE_STATUS = choices('connected', 'planned', 'decommissioning');
const CABLE_TYPES = choices(
  ['cat3', 'CAT3'], ['cat5', 'CAT5'], ['cat5e', 'CAT5e'], ['cat6', 'CAT6'], ['cat6a', 'CAT6a'], ['cat7', 'CAT7'], ['cat8', 'CAT8'],
  ['dac-active', 'Direct Attach Copper (Active)'], ['dac-passive', 'Direct Attach Copper (Passive)'], ['coaxial', 'Coaxial'],
  ['mmf', 'Multimode Fiber'], ['mmf-om3', 'Multimode Fiber (OM3)'], ['mmf-om4', 'Multimode Fiber (OM4)'],
  ['smf', 'Singlemode Fiber'], ['smf-os2', 'Singlemode Fiber (OS2)'], ['aoc', 'Active Optical Cabling (AOC)'], ['power', 'Power'],
);
const LENGTH_UNITS = choices(['km', 'Kilometers'], ['m', 'Meters'], ['cm', 'Centimeters'], ['mi', 'Miles'], ['ft', 'Feet'], ['in', 'Inches']);
const FACES = choices('front', 'rear');
const IFACE_MODES = choices('access', ['tagged', 'Tagged'], ['tagged-all', 'Tagged (All)']);

const deviceIdsFilter = (sqlFor: string) => (values: string[]): SqlFrag => ({
  sql: `t.device_id IN (SELECT id FROM nb_devices WHERE ${sqlFor} IN (${values.map(() => '?').join(',')}))`,
  params: values,
});

function sameSite(ctx: Ctx, errors: Errors, field: string, type: string, id: number | null, siteId: number | null, label: string) {
  if (id == null) return;
  const obj = ctx.get(type, id);
  if (obj && obj.site_id !== siteId) addError(errors, field, `${label} must belong to the assigned site.`);
}

/** Parses `a_terminations` / `b_terminations` into interface ids. */
function parseTerminations(raw: unknown, side: string, errors: Errors, ctx: Ctx): number[] {
  if (!Array.isArray(raw)) {
    addError(errors, side, 'Provide a list of terminations, e.g. [{"object_type": "dcim.interface", "object_id": 1}].');
    return [];
  }
  const ids: number[] = [];
  for (const t of raw) {
    let id: unknown = t;
    if (t && typeof t === 'object') {
      const o = t as Record<string, unknown>;
      const type = o.object_type ?? 'dcim.interface';
      if (type !== 'dcim.interface') {
        addError(errors, side, `Unsupported termination type "${String(type)}" (only dcim.interface).`);
        continue;
      }
      id = o.object_id ?? o.id;
    }
    const n = Number(id);
    const iface = Number.isInteger(n) ? ctx.get('dcim.interface', n) : null;
    if (!iface) {
      addError(errors, side, `Interface ${String(id)} not found.`);
      continue;
    }
    if (VIRTUAL_IFACE_TYPES.has(iface.type)) addError(errors, side, `Cables cannot be attached to ${iface.type} interfaces (${iface.name}).`);
    ids.push(n);
  }
  return ids;
}

export const dcimModels: ModelDef[] = [
  {
    type: 'dcim.region',
    app: 'dcim',
    path: 'regions',
    table: 'nb_regions',
    verbose: 'region',
    verbosePlural: 'regions',
    fields: [nameF(), slugF, { name: 'parent', kind: 'fk', ref: 'dcim.region', onDelete: 'cascade' }, descriptionF],
    unique: [['parent', 'name'], ['parent', 'slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['name'],
    validate: (rec, errors, ctx) => checkTreeCycle(ctx, 'dcim.region', rec, errors),
    serializeExtra: (r, ctx) => ({
      _depth: treeDepth(ctx, 'dcim.region', r),
      site_count: count(ctx, 'SELECT COUNT(*) n FROM nb_sites WHERE region_id = ?', r.id),
    }),
  },
  {
    type: 'dcim.site',
    app: 'dcim',
    path: 'sites',
    table: 'nb_sites',
    verbose: 'site',
    verbosePlural: 'sites',
    fields: [
      nameF(),
      slugF,
      { name: 'status', kind: 'choice', choices: SITE_STATUS, default: 'active', required: true },
      { name: 'region', kind: 'fk', ref: 'dcim.region', onDelete: 'setnull' },
      tenantF,
      { name: 'facility', kind: 'string', maxLength: 50, search: true },
      { name: 'time_zone', kind: 'string', maxLength: 63 },
      descriptionF,
      { name: 'physical_address', kind: 'string', maxLength: 200, search: true },
      { name: 'shipping_address', kind: 'string', maxLength: 200 },
      { name: 'latitude', kind: 'float', min: -90, max: 90 },
      { name: 'longitude', kind: 'float', min: -180, max: 180 },
      commentsF,
    ],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['name'],
    filters: {
      region_id: (values) => {
        // includes child regions; `null` matches sites without a region
        const ids = values.filter((v) => v !== 'null');
        const parts: string[] = [];
        if (ids.length) {
          parts.push(
            `t.region_id IN (WITH RECURSIVE r(id) AS (SELECT id FROM nb_regions WHERE id IN (${ids.map(() => '?').join(',')}) UNION SELECT c.id FROM nb_regions c JOIN r ON c.parent_id = r.id) SELECT id FROM r)`,
          );
        }
        if (ids.length < values.length) parts.push('t.region_id IS NULL');
        return { sql: `(${parts.join(' OR ')})`, params: ids };
      },
    },
    serializeExtra: (r, ctx) => ({
      location_count: count(ctx, 'SELECT COUNT(*) n FROM nb_locations WHERE site_id = ?', r.id),
      rack_count: count(ctx, 'SELECT COUNT(*) n FROM nb_racks WHERE site_id = ?', r.id),
      device_count: count(ctx, 'SELECT COUNT(*) n FROM nb_devices WHERE site_id = ?', r.id),
      prefix_count: count(ctx, 'SELECT COUNT(*) n FROM nb_prefixes WHERE site_id = ?', r.id),
      vlan_count: count(ctx, 'SELECT COUNT(*) n FROM nb_vlans WHERE site_id = ?', r.id),
    }),
  },
  {
    type: 'dcim.location',
    app: 'dcim',
    path: 'locations',
    table: 'nb_locations',
    verbose: 'location',
    verbosePlural: 'locations',
    fields: [
      nameF(),
      slugF,
      { name: 'site', kind: 'fk', ref: 'dcim.site', required: true, onDelete: 'cascade' },
      { name: 'parent', kind: 'fk', ref: 'dcim.location', onDelete: 'cascade' },
      { name: 'status', kind: 'choice', choices: SITE_STATUS, default: 'active', required: true },
      tenantF,
      descriptionF,
    ],
    unique: [['site', 'parent', 'name'], ['site', 'parent', 'slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['site', 'name'],
    validate(rec, errors, ctx) {
      checkTreeCycle(ctx, 'dcim.location', rec, errors);
      sameSite(ctx, errors, 'parent', 'dcim.location', rec.parent_id, rec.site_id, 'Parent location');
    },
    serializeExtra: (r, ctx) => ({
      _depth: treeDepth(ctx, 'dcim.location', r),
      rack_count: count(ctx, 'SELECT COUNT(*) n FROM nb_racks WHERE location_id = ?', r.id),
      device_count: count(ctx, 'SELECT COUNT(*) n FROM nb_devices WHERE location_id = ?', r.id),
    }),
  },
  {
    type: 'dcim.rackrole',
    app: 'dcim',
    path: 'rack-roles',
    table: 'nb_rack_roles',
    verbose: 'rack role',
    verbosePlural: 'rack roles',
    fields: [nameF(), slugF, colorF(), descriptionF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug', 'color'],
    display: (r) => r.name,
    ordering: ['name'],
    serializeExtra: (r, ctx) => ({ rack_count: count(ctx, 'SELECT COUNT(*) n FROM nb_racks WHERE role_id = ?', r.id) }),
  },
  {
    type: 'dcim.rack',
    app: 'dcim',
    path: 'racks',
    table: 'nb_racks',
    verbose: 'rack',
    verbosePlural: 'racks',
    fields: [
      nameF(),
      { name: 'facility_id', kind: 'string', maxLength: 50, search: true },
      { name: 'site', kind: 'fk', ref: 'dcim.site', required: true },
      { name: 'location', kind: 'fk', ref: 'dcim.location' },
      tenantF,
      { name: 'status', kind: 'choice', choices: RACK_STATUS, default: 'active', required: true },
      { name: 'role', kind: 'fk', ref: 'dcim.rackrole', onDelete: 'setnull' },
      { name: 'serial', kind: 'string', maxLength: 50, search: true },
      { name: 'asset_tag', kind: 'string', maxLength: 50, search: true },
      {
        name: 'form_factor',
        kind: 'choice',
        choices: choices(['2-post-frame', '2-post frame'], ['4-post-frame', '4-post frame'], ['4-post-cabinet', '4-post cabinet'], ['wall-frame', 'Wall-mounted frame'], ['wall-cabinet', 'Wall-mounted cabinet']),
      },
      { name: 'width', kind: 'int', intChoices: [10, 19, 21, 23], default: 19, required: true },
      { name: 'u_height', kind: 'int', min: 1, max: 100, default: 42, required: true },
      { name: 'desc_units', kind: 'bool' },
      descriptionF,
      commentsF,
    ],
    unique: [['site', 'location', 'name'], ['asset_tag']],
    brief: ['name'],
    display: (r) => r.name,
    ordering: ['site', 'location', 'name'],
    validate(rec, errors, ctx, info) {
      sameSite(ctx, errors, 'location', 'dcim.location', rec.location_id, rec.site_id, 'Location');
      if (info.existing && rec.u_height != null) {
        const top = Math.max(0, ...rackPlacements(ctx, rec.id).map((p) => p.position + p.u_height - 1));
        if (top > rec.u_height) addError(errors, 'u_height', `Rack must be at least ${top}U tall to house currently installed devices.`);
      }
      if (info.existing && rec.site_id !== info.existing.site_id) {
        if (count(ctx, 'SELECT COUNT(*) n FROM nb_devices WHERE rack_id = ?', rec.id) > 0) addError(errors, 'site', 'Cannot move a rack that contains devices to another site.');
      }
    },
    serializeExtra(r, ctx) {
      const used = new Set<number>();
      for (const p of rackPlacements(ctx, r.id)) for (let u = p.position; u < p.position + p.u_height; u++) used.add(u);
      return {
        device_count: count(ctx, 'SELECT COUNT(*) n FROM nb_devices WHERE rack_id = ?', r.id),
        _utilization: r.u_height ? Math.round((used.size / r.u_height) * 1000) / 10 : 0,
      };
    },
  },
  {
    type: 'dcim.manufacturer',
    app: 'dcim',
    path: 'manufacturers',
    table: 'nb_manufacturers',
    verbose: 'manufacturer',
    verbosePlural: 'manufacturers',
    fields: [nameF(), slugF, descriptionF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['name'],
    serializeExtra: (r, ctx) => ({
      devicetype_count: count(ctx, 'SELECT COUNT(*) n FROM nb_device_types WHERE manufacturer_id = ?', r.id),
      platform_count: count(ctx, 'SELECT COUNT(*) n FROM nb_platforms WHERE manufacturer_id = ?', r.id),
    }),
  },
  {
    type: 'dcim.devicetype',
    app: 'dcim',
    path: 'device-types',
    table: 'nb_device_types',
    verbose: 'device type',
    verbosePlural: 'device types',
    fields: [
      { name: 'manufacturer', kind: 'fk', ref: 'dcim.manufacturer', required: true },
      { name: 'model', kind: 'string', required: true, maxLength: 100, search: true },
      slugF,
      { name: 'part_number', kind: 'string', maxLength: 50, search: true },
      { name: 'u_height', kind: 'int', min: 0, max: 100, default: 1, required: true },
      { name: 'is_full_depth', kind: 'bool', default: true },
      descriptionF,
      commentsF,
    ],
    unique: [['manufacturer', 'model'], ['manufacturer', 'slug']],
    brief: ['manufacturer', 'model', 'slug'],
    display: (r) => r.model,
    ordering: ['manufacturer', 'model'],
    validate(rec, errors, ctx, info) {
      if (!info.existing) return;
      if (rec.u_height === info.existing.u_height && !!rec.is_full_depth === !!info.existing.is_full_depth) return;
      const racked = ctx.db.prepare('SELECT * FROM nb_devices WHERE device_type_id = ? AND position IS NOT NULL').all(rec.id) as Row[];
      for (const d of racked) {
        const e: Errors = {};
        checkPlacement(ctx, d, e, { u_height: rec.u_height, is_full_depth: !!rec.is_full_depth });
        if (e.position) {
          addError(errors, 'u_height', `Device ${d.name ?? d.id} would no longer fit in its rack: ${e.position[0]}`);
          break;
        }
      }
    },
    serializeExtra: (r, ctx) => ({
      device_count: count(ctx, 'SELECT COUNT(*) n FROM nb_devices WHERE device_type_id = ?', r.id),
      interface_template_count: count(ctx, 'SELECT COUNT(*) n FROM nb_interface_templates WHERE device_type_id = ?', r.id),
    }),
  },
  {
    type: 'dcim.interfacetemplate',
    app: 'dcim',
    path: 'interface-templates',
    table: 'nb_interface_templates',
    verbose: 'interface template',
    verbosePlural: 'interface templates',
    fields: [
      { name: 'device_type', kind: 'fk', ref: 'dcim.devicetype', required: true, onDelete: 'cascade' },
      nameF(64),
      { name: 'label', kind: 'string', maxLength: 64 },
      { name: 'type', kind: 'choice', choices: INTERFACE_TYPES, required: true },
      { name: 'enabled', kind: 'bool', default: true },
      { name: 'mgmt_only', kind: 'bool' },
      descriptionF,
    ],
    unique: [['device_type', 'name']],
    brief: ['name'],
    display: (r) => r.name,
    ordering: ['device_type', 'name'],
    taggable: false,
    customFields: false,
  },
  {
    type: 'dcim.devicerole',
    app: 'dcim',
    path: 'device-roles',
    table: 'nb_device_roles',
    verbose: 'device role',
    verbosePlural: 'device roles',
    fields: [nameF(), slugF, colorF(), { name: 'vm_role', kind: 'bool', default: true }, descriptionF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug', 'color'],
    display: (r) => r.name,
    ordering: ['name'],
    serializeExtra: (r, ctx) => ({ device_count: count(ctx, 'SELECT COUNT(*) n FROM nb_devices WHERE role_id = ?', r.id) }),
  },
  {
    type: 'dcim.platform',
    app: 'dcim',
    path: 'platforms',
    table: 'nb_platforms',
    verbose: 'platform',
    verbosePlural: 'platforms',
    fields: [nameF(), slugF, { name: 'manufacturer', kind: 'fk', ref: 'dcim.manufacturer', onDelete: 'setnull' }, descriptionF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['name'],
    serializeExtra: (r, ctx) => ({ device_count: count(ctx, 'SELECT COUNT(*) n FROM nb_devices WHERE platform_id = ?', r.id) }),
  },
  {
    type: 'dcim.device',
    app: 'dcim',
    path: 'devices',
    table: 'nb_devices',
    verbose: 'device',
    verbosePlural: 'devices',
    fields: [
      { name: 'name', kind: 'string', maxLength: 64, search: true },
      { name: 'device_type', kind: 'fk', ref: 'dcim.devicetype', required: true },
      { name: 'role', kind: 'fk', ref: 'dcim.devicerole', required: true },
      tenantF,
      { name: 'platform', kind: 'fk', ref: 'dcim.platform', onDelete: 'setnull' },
      { name: 'serial', kind: 'string', maxLength: 50, search: true },
      { name: 'asset_tag', kind: 'string', maxLength: 50, search: true },
      { name: 'site', kind: 'fk', ref: 'dcim.site', required: true },
      { name: 'location', kind: 'fk', ref: 'dcim.location' },
      { name: 'rack', kind: 'fk', ref: 'dcim.rack' },
      { name: 'position', kind: 'int', min: 1, max: 100 },
      { name: 'face', kind: 'choice', choices: FACES },
      { name: 'status', kind: 'choice', choices: DEVICE_STATUS, default: 'active', required: true },
      { name: 'primary_ip4', kind: 'fk', ref: 'ipam.ipaddress', onDelete: 'setnull' },
      { name: 'primary_ip6', kind: 'fk', ref: 'ipam.ipaddress', onDelete: 'setnull' },
      descriptionF,
      commentsF,
    ],
    unique: [['site', 'tenant', 'name'], ['asset_tag']],
    brief: ['name'],
    display: (r, ctx) => r.name ?? `${ctx.get('dcim.devicetype', r.device_type_id)?.model ?? 'Device'} (${r.id})`,
    ordering: ['name'],
    filters: {
      has_primary_ip: (values) => ({
        sql: ['true', '1'].includes(values[0]) ? '(t.primary_ip4_id IS NOT NULL OR t.primary_ip6_id IS NOT NULL)' : '(t.primary_ip4_id IS NULL AND t.primary_ip6_id IS NULL)',
        params: [],
      }),
      manufacturer_id: (values) => ({
        sql: `t.device_type_id IN (SELECT id FROM nb_device_types WHERE manufacturer_id IN (${values.map(() => '?').join(',')}))`,
        params: values,
      }),
    },
    derive(rec, _errors, ctx) {
      if (rec.rack_id != null && rec.location_id == null) rec.location_id = ctx.get('dcim.rack', rec.rack_id)?.location_id ?? null;
      if (rec.position == null && rec.rack_id == null) rec.face = null;
      if (rec.name === '') rec.name = null;
    },
    validate(rec, errors, ctx) {
      sameSite(ctx, errors, 'location', 'dcim.location', rec.location_id, rec.site_id, 'Location');
      sameSite(ctx, errors, 'rack', 'dcim.rack', rec.rack_id, rec.site_id, 'Rack');
      if (rec.rack_id != null && rec.location_id != null) {
        const rack = ctx.get('dcim.rack', rec.rack_id);
        if (rack?.location_id != null && rack.location_id !== rec.location_id) addError(errors, 'rack', 'Rack must belong to the assigned location.');
      }
      checkPlacement(ctx, rec, errors);
      for (const [field, fam] of [['primary_ip4', 4], ['primary_ip6', 6]] as const) {
        const ipId = rec[`${field}_id`];
        if (ipId == null) continue;
        const ip = ctx.get('ipam.ipaddress', ipId);
        if (!ip) continue;
        if (ip.family !== fam) addError(errors, field, `${ip.address} is not an IPv${fam} address.`);
        const iface = ip.assigned_object_type === 'dcim.interface' ? ctx.get('dcim.interface', ip.assigned_object_id) : null;
        if (!iface || iface.device_id !== rec.id) addError(errors, field, `The specified IP address (${ip.address}) is not assigned to this device.`);
      }
    },
    afterWrite(row, ctx, info) {
      if (info.existing) return;
      // Instantiate interface templates from the device type
      const templates = ctx.db.prepare('SELECT * FROM nb_interface_templates WHERE device_type_id = ? ORDER BY id').all(row.device_type_id) as Row[];
      for (const t of templates) {
        ctx.create('dcim.interface', {
          device: row.id,
          name: t.name,
          label: t.label,
          type: t.type,
          enabled: !!t.enabled,
          mgmt_only: !!t.mgmt_only,
          description: t.description,
        });
      }
    },
    beforeDelete(row, ctx) {
      // Clear primary IPs so interface/IP cleanup doesn't trip validation, cables go with the interfaces.
      ctx.db.prepare('UPDATE nb_devices SET primary_ip4_id = NULL, primary_ip6_id = NULL WHERE id = ?').run(row.id);
      ctx.invalidate();
    },
    serializeExtra(r, ctx) {
      const dims = deviceDims(ctx, r);
      return {
        primary_ip: ctx.ref('ipam.ipaddress', r.primary_ip4_id ?? r.primary_ip6_id),
        interface_count: count(ctx, 'SELECT COUNT(*) n FROM nb_interfaces WHERE device_id = ?', r.id),
        u_height: dims.u_height,
      };
    },
  },
  {
    type: 'dcim.interface',
    app: 'dcim',
    path: 'interfaces',
    table: 'nb_interfaces',
    verbose: 'interface',
    verbosePlural: 'interfaces',
    fields: [
      { name: 'device', kind: 'fk', ref: 'dcim.device', required: true, onDelete: 'cascade' },
      nameF(64),
      { name: 'label', kind: 'string', maxLength: 64, search: true },
      { name: 'type', kind: 'choice', choices: INTERFACE_TYPES, required: true },
      { name: 'enabled', kind: 'bool', default: true },
      { name: 'parent', kind: 'fk', ref: 'dcim.interface', onDelete: 'setnull' },
      { name: 'lag', kind: 'fk', ref: 'dcim.interface', onDelete: 'setnull' },
      { name: 'mtu', kind: 'int', min: 1, max: 65536 },
      { name: 'mac_address', kind: 'mac', search: true },
      { name: 'speed', kind: 'int', min: 0 },
      { name: 'mgmt_only', kind: 'bool' },
      descriptionF,
      { name: 'mode', kind: 'choice', choices: IFACE_MODES },
      { name: 'untagged_vlan', kind: 'fk', ref: 'ipam.vlan', onDelete: 'setnull' },
      { name: 'tagged_vlans', kind: 'm2m', ref: 'ipam.vlan' },
      { name: 'mark_connected', kind: 'bool' },
      { name: 'cable', kind: 'fk', ref: 'dcim.cable', readOnly: true, onDelete: 'setnull' },
      { name: 'cable_end', kind: 'string', readOnly: true },
    ],
    unique: [['device', 'name']],
    brief: ['device', 'name', 'cable'],
    display: (r) => r.name,
    ordering: ['device', 'name'],
    filters: {
      site_id: deviceIdsFilter('site_id'),
      rack_id: deviceIdsFilter('rack_id'),
      role_id: deviceIdsFilter('role_id'),
      cabled: (values) => ({ sql: ['true', '1'].includes(values[0]) ? 't.cable_id IS NOT NULL' : 't.cable_id IS NULL', params: [] }),
      vlan_id: (values) => ({
        sql: `(t.untagged_vlan_id IN (${values.map(() => '?').join(',')}) OR t.id IN (SELECT src_id FROM nb_m2m WHERE field = 'dcim.interface.tagged_vlans' AND dst_id IN (${values.map(() => '?').join(',')})))`,
        params: [...values, ...values],
      }),
    },
    derive(rec, _errors, _ctx, info) {
      if (rec.mode == null) {
        rec.untagged_vlan_id = null;
        info.m2m.tagged_vlans = [];
      } else if (rec.mode !== 'tagged') {
        info.m2m.tagged_vlans = [];
      }
    },
    validate(rec, errors, ctx, info) {
      for (const field of ['lag', 'parent'] as const) {
        const id = rec[`${field}_id`];
        if (id == null) continue;
        if (id === rec.id) addError(errors, field, 'An interface cannot be its own parent or LAG.');
        const other = ctx.get('dcim.interface', id);
        if (other && other.device_id !== rec.device_id) addError(errors, field, `The selected ${field} interface belongs to a different device.`);
        if (field === 'lag' && other && other.type !== 'lag') addError(errors, 'lag', `${other.name} is not a LAG interface.`);
      }
      if (rec.type === 'lag' && rec.lag_id != null) addError(errors, 'lag', 'A LAG interface cannot itself be a LAG member.');
      if (rec.cable_id != null && VIRTUAL_IFACE_TYPES.has(rec.type)) addError(errors, 'type', 'Cabled interfaces cannot be virtual, bridge or LAG.');
      if (info.existing && info.existing.device_id !== rec.device_id) addError(errors, 'device', 'Interfaces cannot be moved to another device.');
      const device = ctx.get('dcim.device', rec.device_id);
      const vlanIds = [rec.untagged_vlan_id, ...(info.m2m.tagged_vlans ?? [])].filter((v) => v != null);
      for (const vid of vlanIds) {
        const vlan = ctx.get('ipam.vlan', vid);
        if (vlan && vlan.site_id != null && device && vlan.site_id !== device.site_id) {
          addError(errors, vid === rec.untagged_vlan_id ? 'untagged_vlan' : 'tagged_vlans', `VLAN ${vlan.name} (${vlan.vid}) belongs to a different site than the device.`);
        }
      }
    },
    beforeDelete(row, ctx) {
      if (row.cable_id != null) ctx.remove('dcim.cable', row.cable_id);
      ctx.db.prepare("UPDATE nb_ip_addresses SET assigned_object_type = NULL, assigned_object_id = NULL WHERE assigned_object_type = 'dcim.interface' AND assigned_object_id = ?").run(row.id);
      ctx.invalidate();
    },
    serializeExtra(r, ctx) {
      const peers = linkPeers(ctx, r);
      const endpoints = peers.map((p) => ctx.ref('dcim.interface', p.id));
      return {
        link_peers: endpoints,
        link_peers_type: peers.length ? 'dcim.interface' : null,
        connected_endpoints: endpoints.length ? endpoints : null,
        connected_endpoints_type: peers.length ? 'dcim.interface' : null,
        connected_endpoints_reachable: peers.length ? true : null,
        _occupied: r.cable_id != null || !!r.mark_connected,
        count_ipaddresses: count(ctx, "SELECT COUNT(*) n FROM nb_ip_addresses WHERE assigned_object_type = 'dcim.interface' AND assigned_object_id = ?", r.id),
      };
    },
  },
  {
    type: 'dcim.cable',
    app: 'dcim',
    path: 'cables',
    table: 'nb_cables',
    verbose: 'cable',
    verbosePlural: 'cables',
    fields: [
      { name: 'type', kind: 'choice', choices: CABLE_TYPES },
      { name: 'status', kind: 'choice', choices: CABLE_STATUS, default: 'connected', required: true },
      tenantF,
      { name: 'label', kind: 'string', maxLength: 100, search: true },
      colorF(''),
      { name: 'length', kind: 'float', min: 0 },
      { name: 'length_unit', kind: 'choice', choices: LENGTH_UNITS },
      descriptionF,
      commentsF,
    ],
    brief: ['label'],
    display: (r) => r.label || `#${r.id}`,
    ordering: ['id'],
    writeExtras: ['a_terminations', 'b_terminations'],
    filters: {
      device_id: (values) => ({
        sql: `t.id IN (SELECT cable_id FROM nb_interfaces WHERE device_id IN (${values.map(() => '?').join(',')}))`,
        params: values,
      }),
      site_id: (values) => ({
        sql: `t.id IN (SELECT i.cable_id FROM nb_interfaces i JOIN nb_devices d ON d.id = i.device_id WHERE d.site_id IN (${values.map(() => '?').join(',')}))`,
        params: values,
      }),
      interface_id: (values) => ({
        sql: `t.id IN (SELECT cable_id FROM nb_interfaces WHERE id IN (${values.map(() => '?').join(',')}))`,
        params: values,
      }),
    },
    derive(rec) {
      if (rec.color === '') rec.color = null;
      if (rec.length == null) rec.length_unit = rec.length_unit ?? null;
    },
    validate(rec, errors, ctx, info) {
      if (rec.length != null && rec.length_unit == null) addError(errors, 'length_unit', 'Must specify a unit when setting a cable length.');
      const sides: Record<'a' | 'b', number[] | null> = { a: null, b: null };
      for (const side of ['a', 'b'] as const) {
        const key = `${side}_terminations`;
        if (key in info.extras) sides[side] = parseTerminations(info.extras[key], key, errors, ctx);
        else if (!info.existing) addError(errors, key, 'This field is required.');
      }
      for (const side of ['a', 'b'] as const) {
        const ids = sides[side];
        if (!ids) continue;
        if (ids.length === 0) addError(errors, `${side}_terminations`, 'At least one termination is required.');
        for (const id of ids) {
          const iface = ctx.get('dcim.interface', id)!;
          if (iface.cable_id != null && iface.cable_id !== rec.id) {
            addError(errors, `${side}_terminations`, `${ctx.get('dcim.device', iface.device_id)?.name ?? ''} ${iface.name} already has a cable (#${iface.cable_id}).`);
          }
        }
      }
      if (sides.a && sides.b && sides.a.some((id) => sides.b!.includes(id))) addError(errors, 'b_terminations', 'An interface cannot be on both ends of a cable.');
      info.extras.__sides = sides;
    },
    afterWrite(row, ctx, info) {
      const sides = info.extras.__sides as Record<'a' | 'b', number[] | null>;
      for (const side of ['a', 'b'] as const) {
        const ids = sides[side];
        if (!ids) continue;
        const end = side.toUpperCase();
        ctx.db.prepare('UPDATE nb_interfaces SET cable_id = NULL, cable_end = NULL WHERE cable_id = ? AND cable_end = ?').run(row.id, end);
        const upd = ctx.db.prepare('UPDATE nb_interfaces SET cable_id = ?, cable_end = ? WHERE id = ?');
        for (const id of ids) upd.run(row.id, end, id);
      }
      ctx.invalidate();
    },
    beforeDelete(row, ctx) {
      ctx.db.prepare('UPDATE nb_interfaces SET cable_id = NULL, cable_end = NULL WHERE cable_id = ?').run(row.id);
      ctx.invalidate();
    },
    serializeExtra(r, ctx) {
      const ends = ctx.db.prepare('SELECT id, cable_end FROM nb_interfaces WHERE cable_id = ? ORDER BY id').all(r.id) as Row[];
      return {
        a_terminations: ends.filter((e) => e.cable_end === 'A').map((e) => ifaceTermination(ctx, e.id)),
        b_terminations: ends.filter((e) => e.cable_end === 'B').map((e) => ifaceTermination(ctx, e.id)),
      };
    },
  },
];
