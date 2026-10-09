import { cableEnds, clearCableEnds, connectionFields, parseTerminations, setCableEnds, termObj, TERMINATION_TYPES, validateCableSides, VIRTUAL_IFACE_TYPES } from '../cabling.js';
import { checkPlacement, INTERFACE_TYPES, rackPlacements, deviceDims } from '../dcim.js';
import { feedAvailablePower, feedLoad, powerPortDraw, rackPowerUtilization } from '../power.js';
import type { Ctx, Errors, FieldDef, ModelDef, Row, SqlFrag } from '../types.js';
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
const POWERFEED_STATUS = choices('offline', 'active', 'planned', 'failed');
const PORT_TYPES = choices(
  ['8p8c', '8P8C'], ['8p6c', '8P6C'], ['110-punch', '110 Punch'], ['bnc', 'BNC'], ['f', 'F Connector'], ['n', 'N Connector'], ['mrj21', 'MRJ21'],
  ['fc', 'FC'], ['lc', 'LC'], ['lc-pc', 'LC/PC'], ['lc-upc', 'LC/UPC'], ['lc-apc', 'LC/APC'], ['lsh', 'LSH'], ['mpo', 'MPO'], ['mtrj', 'MTRJ'],
  ['sc', 'SC'], ['sc-pc', 'SC/PC'], ['sc-upc', 'SC/UPC'], ['sc-apc', 'SC/APC'], ['st', 'ST'], ['cs', 'CS'], ['sn', 'SN'], ['splice', 'Splice'], ['other', 'Other'],
);
const POWERPORT_TYPES = choices(
  ['iec-60320-c6', 'C6'], ['iec-60320-c8', 'C8'], ['iec-60320-c14', 'C14'], ['iec-60320-c16', 'C16'], ['iec-60320-c20', 'C20'],
  ['iec-60309-p-n-e-6h', 'P+N+E 6H'], ['iec-60309-3p-n-e-6h', '3P+N+E 6H'], ['nema-5-15p', 'NEMA 5-15P'], ['nema-l5-30p', 'NEMA L5-30P'], ['nema-l6-30p', 'NEMA L6-30P'],
  ['cee-7-7', 'CEE 7/7 (Schuko)'], ['dc-terminal', 'DC Terminal'], ['hardwired', 'Hardwired'], ['other', 'Other'],
);
const POWEROUTLET_TYPES = choices(
  ['iec-60320-c5', 'C5'], ['iec-60320-c7', 'C7'], ['iec-60320-c13', 'C13'], ['iec-60320-c15', 'C15'], ['iec-60320-c19', 'C19'],
  ['iec-60309-p-n-e-6h', 'P+N+E 6H'], ['iec-60309-3p-n-e-6h', '3P+N+E 6H'], ['nema-5-15r', 'NEMA 5-15R'], ['nema-l5-30r', 'NEMA L5-30R'], ['nema-l6-30r', 'NEMA L6-30R'],
  ['cee-7-3', 'CEE 7/3 (Schuko)'], ['dc-terminal', 'DC Terminal'], ['hardwired', 'Hardwired'], ['other', 'Other'],
);

/** Read-only cable columns of every cable termination. */
const cableFields: FieldDef[] = [
  { name: 'mark_connected', kind: 'bool' },
  { name: 'cable', kind: 'fk', ref: 'dcim.cable', readOnly: true, onDelete: 'setnull' },
  { name: 'cable_end', kind: 'string', readOnly: true },
];
const cabledFilter = (values: string[]): SqlFrag => ({ sql: ['true', '1'].includes(values[0]) ? 't.cable_id IS NOT NULL' : 't.cable_id IS NULL', params: [] });
/** Tables of device components that take cables. */
const DEVICE_TERM_TABLES = ['nb_interfaces', 'nb_front_ports', 'nb_rear_ports', 'nb_power_ports', 'nb_power_outlets'];
const deviceCableIds = (values: string[], col: string) =>
  DEVICE_TERM_TABLES.map((tb) => `SELECT cable_id FROM ${tb} WHERE ${col} IN (${values.map(() => '?').join(',')})`).join(' UNION ');
const termFilter = (table: string) => (values: string[]): SqlFrag => ({ sql: `t.id IN (SELECT cable_id FROM ${table} WHERE id IN (${values.map(() => '?').join(',')}))`, params: values });

const deviceIdsFilter = (sqlFor: string) => (values: string[]): SqlFrag => ({
  sql: `t.device_id IN (SELECT id FROM nb_devices WHERE ${sqlFor} IN (${values.map(() => '?').join(',')}))`,
  params: values,
});

function sameSite(ctx: Ctx, errors: Errors, field: string, type: string, id: number | null, siteId: number | null, label: string) {
  if (id == null) return;
  const obj = ctx.get(type, id);
  if (obj && obj.site_id !== siteId) addError(errors, field, `${label} must belong to the assigned site.`);
}

const clearPrefixScope = (ctx: Ctx, type: string, id: number) => {
  ctx.db.prepare('UPDATE nb_prefixes SET scope_type = NULL, scope_id = NULL WHERE scope_type = ? AND scope_id = ?').run(type, id);
  ctx.invalidate();
};

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
    beforeDelete: (r, ctx) => clearPrefixScope(ctx, 'dcim.region', r.id),
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
    beforeDelete: (r, ctx) => clearPrefixScope(ctx, 'dcim.location', r.id),
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
        powerfeed_count: count(ctx, 'SELECT COUNT(*) n FROM nb_power_feeds WHERE rack_id = ?', r.id),
        _utilization: r.u_height ? Math.round((used.size / r.u_height) * 1000) / 10 : 0,
        _power_utilization: rackPowerUtilization(ctx, r.id),
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
      front_port_template_count: count(ctx, 'SELECT COUNT(*) n FROM nb_front_port_templates WHERE device_type_id = ?', r.id),
      rear_port_template_count: count(ctx, 'SELECT COUNT(*) n FROM nb_rear_port_templates WHERE device_type_id = ?', r.id),
      power_port_template_count: count(ctx, 'SELECT COUNT(*) n FROM nb_power_port_templates WHERE device_type_id = ?', r.id),
      power_outlet_template_count: count(ctx, 'SELECT COUNT(*) n FROM nb_power_outlet_templates WHERE device_type_id = ?', r.id),
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
      { name: 'cluster', kind: 'fk', ref: 'virtualization.cluster', onDelete: 'setnull' },
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
      if (rec.cluster_id != null) {
        const cluster = ctx.get('virtualization.cluster', rec.cluster_id);
        if (cluster?.site_id != null && cluster.site_id !== rec.site_id) addError(errors, 'cluster', `The assigned cluster belongs to a different site (${ctx.get('dcim.site', cluster.site_id)?.name}).`);
      }
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
      instantiateComponents(ctx, row);
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
        front_port_count: count(ctx, 'SELECT COUNT(*) n FROM nb_front_ports WHERE device_id = ?', r.id),
        rear_port_count: count(ctx, 'SELECT COUNT(*) n FROM nb_rear_ports WHERE device_id = ?', r.id),
        power_port_count: count(ctx, 'SELECT COUNT(*) n FROM nb_power_ports WHERE device_id = ?', r.id),
        power_outlet_count: count(ctx, 'SELECT COUNT(*) n FROM nb_power_outlets WHERE device_id = ?', r.id),
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
      return {
        ...connectionFields(ctx, 'dcim.interface', r),
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
      device_id: (values) => ({ sql: `t.id IN (${deviceCableIds(values, 'device_id')})`, params: DEVICE_TERM_TABLES.flatMap(() => values) }),
      rack_id: (values) => ({
        sql: `t.id IN (${DEVICE_TERM_TABLES.map((tb) => `SELECT x.cable_id FROM ${tb} x JOIN nb_devices d ON d.id = x.device_id WHERE d.rack_id IN (${values.map(() => '?').join(',')})`).join(' UNION ')} UNION SELECT cable_id FROM nb_power_feeds WHERE rack_id IN (${values.map(() => '?').join(',')}))`,
        params: [...DEVICE_TERM_TABLES.flatMap(() => values), ...values],
      }),
      site_id: (values) => {
        const p = values.map(() => '?').join(',');
        return {
          sql: `t.id IN (${DEVICE_TERM_TABLES.map((tb) => `SELECT x.cable_id FROM ${tb} x JOIN nb_devices d ON d.id = x.device_id WHERE d.site_id IN (${p})`).join(' UNION ')}
            UNION SELECT cable_id FROM nb_circuit_terminations WHERE site_id IN (${p})
            UNION SELECT f.cable_id FROM nb_power_feeds f JOIN nb_power_panels pp ON pp.id = f.power_panel_id WHERE pp.site_id IN (${p}))`,
          params: [...DEVICE_TERM_TABLES.flatMap(() => values), ...values, ...values],
        };
      },
      interface_id: termFilter('nb_interfaces'),
      frontport_id: termFilter('nb_front_ports'),
      rearport_id: termFilter('nb_rear_ports'),
      powerport_id: termFilter('nb_power_ports'),
      poweroutlet_id: termFilter('nb_power_outlets'),
      powerfeed_id: termFilter('nb_power_feeds'),
      circuittermination_id: termFilter('nb_circuit_terminations'),
      circuit_id: (values) => ({ sql: `t.id IN (SELECT cable_id FROM nb_circuit_terminations WHERE circuit_id IN (${values.map(() => '?').join(',')}))`, params: values }),
      termination_type: (values) => ({
        sql: `(${values.map((v) => (TERMINATION_TYPES[v] ? `t.id IN (SELECT cable_id FROM ${TERMINATION_TYPES[v].table})` : '0')).join(' OR ')})`,
        params: [],
      }),
    },
    derive(rec) {
      if (rec.color === '') rec.color = null;
      if (rec.length == null) rec.length_unit = rec.length_unit ?? null;
    },
    validate(rec, errors, ctx, info) {
      if (rec.length != null && rec.length_unit == null) addError(errors, 'length_unit', 'Must specify a unit when setting a cable length.');
      const sides: Record<'a' | 'b', { type: string; id: number }[] | null> = { a: null, b: null };
      for (const side of ['a', 'b'] as const) {
        const key = `${side}_terminations`;
        if (key in info.extras) sides[side] = parseTerminations(ctx, info.extras[key], key, errors);
        else if (!info.existing) addError(errors, key, 'This field is required.');
      }
      // On update with one side given, check compatibility against the stored other side.
      if (info.existing && (!sides.a || !sides.b)) {
        const ends = cableEnds(ctx, rec.id);
        const check = {
          a: sides.a ?? ends.filter((e) => e.end === 'A').map((e) => ({ type: e.type, id: e.row.id })),
          b: sides.b ?? ends.filter((e) => e.end === 'B').map((e) => ({ type: e.type, id: e.row.id })),
        };
        validateCableSides(ctx, rec.id, check, errors);
      } else validateCableSides(ctx, rec.id ?? null, sides, errors);
      info.extras.__sides = sides;
    },
    afterWrite(row, ctx, info) {
      const sides = info.extras.__sides as Record<'a' | 'b', { type: string; id: number }[] | null>;
      for (const side of ['a', 'b'] as const) if (sides[side]) setCableEnds(ctx, row.id, side.toUpperCase() as 'A' | 'B', sides[side]!);
    },
    beforeDelete(row, ctx) {
      clearCableEnds(ctx, row.id);
    },
    serializeExtra(r, ctx) {
      const ends = cableEnds(ctx, r.id);
      return {
        a_terminations: ends.filter((e) => e.end === 'A').map((e) => termObj(ctx, e.type, e.row.id)),
        b_terminations: ends.filter((e) => e.end === 'B').map((e) => termObj(ctx, e.type, e.row.id)),
      };
    },
  },
  ...componentModels(),
  {
    type: 'dcim.powerpanel',
    app: 'dcim',
    path: 'power-panels',
    table: 'nb_power_panels',
    verbose: 'power panel',
    verbosePlural: 'power panels',
    fields: [
      { name: 'site', kind: 'fk', ref: 'dcim.site', required: true },
      { name: 'location', kind: 'fk', ref: 'dcim.location' },
      nameF(),
      descriptionF,
      commentsF,
    ],
    unique: [['site', 'name']],
    brief: ['name'],
    display: (r) => r.name,
    ordering: ['site', 'name'],
    validate(rec, errors, ctx) {
      sameSite(ctx, errors, 'location', 'dcim.location', rec.location_id, rec.site_id, 'Location');
    },
    serializeExtra: (r, ctx) => ({ powerfeed_count: count(ctx, 'SELECT COUNT(*) n FROM nb_power_feeds WHERE power_panel_id = ?', r.id) }),
  },
  {
    type: 'dcim.powerfeed',
    app: 'dcim',
    path: 'power-feeds',
    table: 'nb_power_feeds',
    verbose: 'power feed',
    verbosePlural: 'power feeds',
    fields: [
      { name: 'power_panel', kind: 'fk', ref: 'dcim.powerpanel', required: true },
      { name: 'rack', kind: 'fk', ref: 'dcim.rack' },
      nameF(),
      { name: 'status', kind: 'choice', choices: POWERFEED_STATUS, default: 'active', required: true },
      { name: 'type', kind: 'choice', choices: choices('primary', 'redundant'), default: 'primary', required: true },
      { name: 'supply', kind: 'choice', choices: choices(['ac', 'AC'], ['dc', 'DC']), default: 'ac', required: true },
      { name: 'phase', kind: 'choice', choices: choices(['single-phase', 'Single phase'], ['three-phase', 'Three-phase']), default: 'single-phase', required: true },
      { name: 'voltage', kind: 'int', min: -32768, max: 32767, default: 230, required: true },
      { name: 'amperage', kind: 'int', min: 1, max: 32767, default: 16, required: true },
      { name: 'max_utilization', kind: 'int', min: 1, max: 100, default: 80, required: true },
      tenantF,
      descriptionF,
      commentsF,
      ...cableFields,
    ],
    unique: [['power_panel', 'name']],
    brief: ['power_panel', 'name', 'cable'],
    display: (r) => r.name,
    ordering: ['power_panel', 'name'],
    filters: {
      site_id: (values) => ({ sql: `t.power_panel_id IN (SELECT id FROM nb_power_panels WHERE site_id IN (${values.map(() => '?').join(',')}))`, params: values }),
      cabled: cabledFilter,
    },
    validate(rec, errors, ctx) {
      const panel = ctx.get('dcim.powerpanel', rec.power_panel_id);
      if (panel && rec.rack_id != null) {
        const rack = ctx.get('dcim.rack', rec.rack_id);
        if (rack && rack.site_id !== panel.site_id) addError(errors, 'rack', `Rack ${rack.name} (site ${ctx.get('dcim.site', rack.site_id)?.name}) and power panel ${panel.name} (site ${ctx.get('dcim.site', panel.site_id)?.name}) are in different sites.`);
      }
      if (rec.supply === 'ac' && rec.voltage < 0) addError(errors, 'voltage', 'Voltage cannot be negative for AC supply.');
      if (rec.supply === 'dc' && rec.phase === 'three-phase') addError(errors, 'phase', 'DC supply cannot be three-phase.');
    },
    beforeDelete: removeCable,
    serializeExtra(r, ctx) {
      const load = feedLoad(ctx, r);
      const available = feedAvailablePower(r);
      return {
        ...connectionFields(ctx, 'dcim.powerfeed', r),
        site: ctx.ref('dcim.site', ctx.get('dcim.powerpanel', r.power_panel_id)?.site_id),
        available_power: available,
        allocated_draw: load.allocated,
        maximum_draw: load.maximum,
        _utilization: available > 0 ? Math.round((load.allocated / available) * 1000) / 10 : 0,
      };
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Device components (front/rear ports, power ports/outlets) and their templates

function removeCable(row: Row, ctx: Ctx) {
  if (row.cable_id != null) ctx.remove('dcim.cable', row.cable_id);
}

function componentModel(def: {
  type: string;
  path: string;
  table: string;
  verbose: string;
  verbosePlural: string;
  fields: FieldDef[];
  unique?: string[][];
  validate?: ModelDef['validate'];
  serializeExtra?: ModelDef['serializeExtra'];
}): ModelDef {
  return {
    app: 'dcim',
    ...def,
    fields: [
      { name: 'device', kind: 'fk', ref: 'dcim.device', required: true, onDelete: 'cascade' },
      nameF(64),
      { name: 'label', kind: 'string', maxLength: 64, search: true },
      ...def.fields,
      descriptionF,
      ...cableFields,
    ],
    unique: [['device', 'name'], ...(def.unique ?? [])],
    brief: ['device', 'name', 'cable'],
    display: (r) => r.name,
    ordering: ['device', 'name'],
    filters: {
      site_id: deviceIdsFilter('site_id'),
      rack_id: deviceIdsFilter('rack_id'),
      role_id: deviceIdsFilter('role_id'),
      cabled: cabledFilter,
    },
    validate(rec, errors, ctx, info) {
      if (info.existing && info.existing.device_id !== rec.device_id) addError(errors, 'device', 'Components cannot be moved to another device.');
      def.validate?.(rec, errors, ctx, info);
    },
    beforeDelete: removeCable,
    serializeExtra: (r, ctx) => ({ ...connectionFields(ctx, def.type, r), ...def.serializeExtra?.(r, ctx) }),
  };
}

function templateModel(def: { type: string; path: string; table: string; verbose: string; verbosePlural: string; fields: FieldDef[]; validate?: ModelDef['validate'] }): ModelDef {
  return {
    app: 'dcim',
    ...def,
    fields: [
      { name: 'device_type', kind: 'fk', ref: 'dcim.devicetype', required: true, onDelete: 'cascade' },
      nameF(64),
      { name: 'label', kind: 'string', maxLength: 64 },
      ...def.fields,
      descriptionF,
    ],
    unique: [['device_type', 'name']],
    brief: ['name'],
    display: (r) => r.name,
    ordering: ['device_type', 'name'],
    taggable: false,
    customFields: false,
  };
}

const sameParent = (ctx: Ctx, errors: Errors, field: string, type: string, id: number | null, parentCol: string, parentId: number, what: string) => {
  if (id == null) return null;
  const o = ctx.get(type, id);
  if (o && o[parentCol] !== parentId) addError(errors, field, `The ${what} must belong to the same ${parentCol === 'device_id' ? 'device' : 'device type'}.`);
  return o;
};

function componentModels(): ModelDef[] {
  const rearPositions: FieldDef = { name: 'positions', kind: 'int', min: 1, max: 1024, default: 1, required: true };
  const frontFields = (rearRef: string): FieldDef[] => [
    { name: 'type', kind: 'choice', choices: PORT_TYPES, required: true },
    colorF(''),
    { name: 'rear_port', kind: 'fk', ref: rearRef, required: true, onDelete: 'cascade' },
    { name: 'rear_port_position', kind: 'int', min: 1, max: 1024, default: 1, required: true },
  ];
  const checkFront = (rearType: string, parentCol: string) => (rec: Row, errors: Errors, ctx: Ctx) => {
    if (rec.color === '') rec.color = null;
    const rear = sameParent(ctx, errors, 'rear_port', rearType, rec.rear_port_id, parentCol, rec[parentCol], 'rear port');
    if (rear && rec.rear_port_position != null && rec.rear_port_position > rear.positions) {
      addError(errors, 'rear_port_position', `Invalid rear port position (${rec.rear_port_position}): rear port ${rear.name} has only ${rear.positions} positions.`);
    }
  };
  const checkRear = (frontTable: string) => (rec: Row, errors: Errors, ctx: Ctx, info: { existing: Row | null }) => {
    if (rec.color === '') rec.color = null;
    if (!info.existing || rec.positions == null) return;
    const max = (ctx.db.prepare(`SELECT MAX(rear_port_position) m FROM ${frontTable} WHERE rear_port_id = ?`).get(rec.id) as { m: number | null }).m;
    if (max != null && rec.positions < max) addError(errors, 'positions', `The number of positions cannot be less than the number of mapped front ports (${max}).`);
  };
  const drawFields: FieldDef[] = [
    { name: 'type', kind: 'choice', choices: POWERPORT_TYPES },
    { name: 'maximum_draw', kind: 'int', min: 1, max: 32767 },
    { name: 'allocated_draw', kind: 'int', min: 1, max: 32767 },
  ];
  const checkDraw = (rec: Row, errors: Errors) => {
    if (rec.maximum_draw != null && rec.allocated_draw != null && rec.allocated_draw > rec.maximum_draw) {
      addError(errors, 'allocated_draw', `Allocated draw cannot exceed the maximum draw (${rec.maximum_draw}W).`);
    }
  };
  const outletFields = (portRef: string): FieldDef[] => [
    { name: 'type', kind: 'choice', choices: POWEROUTLET_TYPES },
    { name: 'power_port', kind: 'fk', ref: portRef, onDelete: 'setnull' },
    { name: 'feed_leg', kind: 'choice', choices: choices('A', 'B', 'C') },
  ];
  return [
    componentModel({
      type: 'dcim.rearport',
      path: 'rear-ports',
      table: 'nb_rear_ports',
      verbose: 'rear port',
      verbosePlural: 'rear ports',
      fields: [{ name: 'type', kind: 'choice', choices: PORT_TYPES, required: true }, colorF(''), rearPositions],
      validate: checkRear('nb_front_ports'),
      serializeExtra: (r, ctx) => ({ front_port_count: count(ctx, 'SELECT COUNT(*) n FROM nb_front_ports WHERE rear_port_id = ?', r.id) }),
    }),
    componentModel({
      type: 'dcim.frontport',
      path: 'front-ports',
      table: 'nb_front_ports',
      verbose: 'front port',
      verbosePlural: 'front ports',
      fields: frontFields('dcim.rearport'),
      unique: [['rear_port', 'rear_port_position']],
      validate: checkFront('dcim.rearport', 'device_id'),
    }),
    componentModel({
      type: 'dcim.powerport',
      path: 'power-ports',
      table: 'nb_power_ports',
      verbose: 'power port',
      verbosePlural: 'power ports',
      fields: drawFields,
      validate: checkDraw,
      serializeExtra: (r, ctx) => ({ _power_draw: powerPortDraw(ctx, r) }),
    }),
    componentModel({
      type: 'dcim.poweroutlet',
      path: 'power-outlets',
      table: 'nb_power_outlets',
      verbose: 'power outlet',
      verbosePlural: 'power outlets',
      fields: outletFields('dcim.powerport'),
      validate: (rec, errors, ctx) => void sameParent(ctx, errors, 'power_port', 'dcim.powerport', rec.power_port_id, 'device_id', rec.device_id, 'parent power port'),
    }),
    templateModel({
      type: 'dcim.rearporttemplate',
      path: 'rear-port-templates',
      table: 'nb_rear_port_templates',
      verbose: 'rear port template',
      verbosePlural: 'rear port templates',
      fields: [{ name: 'type', kind: 'choice', choices: PORT_TYPES, required: true }, colorF(''), rearPositions],
      validate: checkRear('nb_front_port_templates'),
    }),
    templateModel({
      type: 'dcim.frontporttemplate',
      path: 'front-port-templates',
      table: 'nb_front_port_templates',
      verbose: 'front port template',
      verbosePlural: 'front port templates',
      fields: frontFields('dcim.rearporttemplate'),
      validate: checkFront('dcim.rearporttemplate', 'device_type_id'),
    }),
    templateModel({
      type: 'dcim.powerporttemplate',
      path: 'power-port-templates',
      table: 'nb_power_port_templates',
      verbose: 'power port template',
      verbosePlural: 'power port templates',
      fields: drawFields,
      validate: checkDraw,
    }),
    templateModel({
      type: 'dcim.poweroutlettemplate',
      path: 'power-outlet-templates',
      table: 'nb_power_outlet_templates',
      verbose: 'power outlet template',
      verbosePlural: 'power outlet templates',
      fields: outletFields('dcim.powerporttemplate'),
      validate: (rec, errors, ctx) => void sameParent(ctx, errors, 'power_port', 'dcim.powerporttemplate', rec.power_port_id, 'device_type_id', rec.device_type_id, 'parent power port'),
    }),
  ];
}

/** Creates a new device's components from its device type's templates. */
function instantiateComponents(ctx: Ctx, device: Row) {
  const tpl = (table: string) => ctx.db.prepare(`SELECT * FROM ${table} WHERE device_type_id = ? ORDER BY id`).all(device.device_type_id) as Row[];
  const base = (t: Row) => ({ device: device.id, name: t.name, label: t.label, description: t.description });
  for (const t of tpl('nb_interface_templates')) ctx.create('dcim.interface', { ...base(t), type: t.type, enabled: !!t.enabled, mgmt_only: !!t.mgmt_only });
  const rearMap = new Map<number, number>();
  for (const t of tpl('nb_rear_port_templates')) rearMap.set(t.id, ctx.create('dcim.rearport', { ...base(t), type: t.type, color: t.color, positions: t.positions }).id);
  for (const t of tpl('nb_front_port_templates')) {
    ctx.create('dcim.frontport', { ...base(t), type: t.type, color: t.color, rear_port: rearMap.get(t.rear_port_id), rear_port_position: t.rear_port_position });
  }
  const portMap = new Map<number, number>();
  for (const t of tpl('nb_power_port_templates')) {
    portMap.set(t.id, ctx.create('dcim.powerport', { ...base(t), type: t.type, maximum_draw: t.maximum_draw, allocated_draw: t.allocated_draw }).id);
  }
  for (const t of tpl('nb_power_outlet_templates')) {
    ctx.create('dcim.poweroutlet', { ...base(t), type: t.type, feed_leg: t.feed_leg, power_port: t.power_port_id != null ? (portMap.get(t.power_port_id) ?? null) : null });
  }
}
