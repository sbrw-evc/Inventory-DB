import { cidrToString, hexKey, ifaceToString, parseCidr, parseIp, type Cidr } from '../cidr.js';
import { badRequest } from '../../errors.js';
import { aggregateUtilization, familyObj, prefixChildren, prefixDepth, prefixUtilization } from '../ipam.js';
import type { Ctx, Errors, ModelDef, Row, SqlFrag, WriteInfo } from '../types.js';
import { choices } from '../types.js';
import { addError, commentsF, count, descriptionF, nameF, slugF, tenantF } from './common.js';

const PREFIX_STATUS = choices('container', 'active', 'reserved', 'deprecated');
const IP_STATUS = choices('active', 'reserved', 'deprecated', ['dhcp', 'DHCP'], ['slaac', 'SLAAC']);
const IP_ROLES = choices('loopback', 'secondary', 'anycast', ['vip', 'VIP'], ['vrrp', 'VRRP'], ['hsrp', 'HSRP'], ['glbp', 'GLBP'], ['carp', 'CARP']);
/** Roles that may legitimately share an address. */
const SHARED_ROLES = ['anycast', 'vip', 'vrrp', 'hsrp', 'glbp', 'carp'];
const VLAN_STATUS = choices('active', 'reserved', 'deprecated');

const ph = (values: unknown[]) => values.map(() => '?').join(',');

const cidrArg = (v: string): Cidr => {
  const c = parseCidr(v, { allowHost: true });
  if (!c) throw badRequest(`Invalid prefix or address "${v}"`, { [v]: ['Enter a valid IPv4 or IPv6 prefix.'] });
  return c;
};

/** OR of one fragment per value. */
const anyOf = (values: string[], one: (c: Cidr) => SqlFrag): SqlFrag => {
  const parts = values.map((v) => one(cidrArg(v)));
  return { sql: `(${parts.map((p) => p.sql).join(' OR ')})`, params: parts.flatMap((p) => p.params) };
};

const within = (startCol: string, endCol: string, strict: boolean) => (values: string[]) =>
  anyOf(values, (c) => ({
    sql: `(t.family = ? AND t.${startCol} >= ? AND t.${endCol} <= ?${strict ? ' AND t.prefix_length > ?' : ''})`,
    params: strict ? [c.family, hexKey(c.network), hexKey(c.last), c.prefixLength] : [c.family, hexKey(c.network), hexKey(c.last)],
  }));

const familyFilter = (values: string[]): SqlFrag => ({ sql: `t.family IN (${ph(values)})`, params: values.map(Number) });
const maskFilter = (op: string) => (values: string[]): SqlFrag =>
  op === '=' ? { sql: `t.prefix_length IN (${ph(values)})`, params: values.map(Number) } : { sql: `t.prefix_length ${op} ?`, params: [Number(values[0])] };

/** Normalises a prefix field and fills family/start_hex/end_hex/prefix_length. */
function deriveNetwork(rec: Row, field: string, errors: Errors) {
  if (rec[field] == null) return;
  const c = parseCidr(rec[field]);
  if (!c) {
    addError(errors, field, 'Enter a valid IPv4 or IPv6 prefix with mask, e.g. 10.0.0.0/24.');
    return;
  }
  rec[field] = cidrToString(c);
  rec.family = c.family;
  rec.start_hex = hexKey(c.network);
  rec.end_hex = hexKey(c.last);
  rec.prefix_length = c.prefixLength;
}

const vrfEnforces = (ctx: Ctx, vrfId: number | null) => vrfId == null || !!ctx.get('ipam.vrf', vrfId)?.enforce_unique;
const vrfName = (ctx: Ctx, vrfId: number | null) => (vrfId == null ? 'global table' : `VRF ${ctx.get('ipam.vrf', vrfId)?.name}`);

const networkCols = { family: 'INTEGER', start_hex: 'TEXT', end_hex: 'TEXT', prefix_length: 'INTEGER' };

const ASSIGNABLE = ['dcim.interface', 'virtualization.vminterface'];
const SCOPE_TYPES = ['dcim.region', 'dcim.site', 'dcim.location'];

const regionTree = (n: number) =>
  `WITH RECURSIVE r(id) AS (SELECT id FROM nb_regions WHERE id IN (${ph(Array(n).fill(0))}) UNION SELECT c.id FROM nb_regions c JOIN r ON c.parent_id = r.id) SELECT id FROM r`;

/**
 * NetBox 4 prefix scope: `scope_type` (region/site/location) + `scope_id`. `site` stays writable for compatibility:
 * setting it scopes the prefix to that site, and a site or location scope fills `site`.
 */
function deriveScope(rec: Row, errors: Errors, ctx: Ctx, info: WriteInfo) {
  const scopeGiven = info.provided.has('scope_type') || info.provided.has('scope_id');
  const siteGiven = info.provided.has('site');
  if (scopeGiven) {
    if (rec.scope_type == null && rec.scope_id == null) {
      if (!siteGiven) rec.site_id = null;
      else if (rec.site_id != null) addError(errors, 'scope_type', 'Clear the site too, or set the scope to the site.');
      return;
    }
    if (rec.scope_type == null || rec.scope_id == null) {
      addError(errors, rec.scope_type == null ? 'scope_type' : 'scope_id', 'scope_type and scope_id must be set together.');
      return;
    }
    if (!SCOPE_TYPES.includes(rec.scope_type)) {
      addError(errors, 'scope_type', `Invalid scope type "${rec.scope_type}" (one of ${SCOPE_TYPES.join(', ')}).`);
      return;
    }
    const obj = ctx.get(rec.scope_type, rec.scope_id);
    if (!obj) {
      addError(errors, 'scope_id', `${rec.scope_type} ${rec.scope_id} not found.`);
      return;
    }
    const site = rec.scope_type === 'dcim.site' ? obj.id : rec.scope_type === 'dcim.location' ? obj.site_id : null;
    if (siteGiven && rec.site_id !== site) addError(errors, 'site', 'The site does not match the scope.');
    rec.site_id = site;
  } else if (siteGiven) {
    rec.scope_type = rec.site_id != null ? 'dcim.site' : null;
    rec.scope_id = rec.site_id;
  }
}

const ifaceDevice = (values: string[], col: string): SqlFrag => ({
  sql: `(t.assigned_object_type = 'dcim.interface' AND t.assigned_object_id IN (SELECT i.id FROM nb_interfaces i JOIN nb_devices d ON d.id = i.device_id WHERE d.${col} IN (${ph(values)})))`,
  params: values,
});

const vmIface = (values: string[], col: string): SqlFrag => ({
  sql: `(t.assigned_object_type = 'virtualization.vminterface' AND t.assigned_object_id IN (SELECT i.id FROM nb_vm_interfaces i JOIN nb_virtual_machines v ON v.id = i.virtual_machine_id WHERE v.${col} IN (${ph(values)})))`,
  params: values,
});

export const ipamModels: ModelDef[] = [
  {
    type: 'ipam.vrf',
    app: 'ipam',
    path: 'vrfs',
    table: 'nb_vrfs',
    verbose: 'VRF',
    verbosePlural: 'VRFs',
    fields: [
      nameF(),
      { name: 'rd', kind: 'string', maxLength: 21, search: true },
      tenantF,
      { name: 'enforce_unique', kind: 'bool', default: true },
      descriptionF,
      commentsF,
      { name: 'import_targets', kind: 'm2m', ref: 'ipam.routetarget' },
      { name: 'export_targets', kind: 'm2m', ref: 'ipam.routetarget' },
    ],
    unique: [['rd']],
    brief: ['name', 'rd'],
    display: (r) => (r.rd ? `${r.name} (${r.rd})` : r.name),
    ordering: ['name', 'rd'],
    derive: (rec) => {
      if (rec.rd === '') rec.rd = null;
    },
    serializeExtra: (r, ctx) => ({
      ipaddress_count: count(ctx, 'SELECT COUNT(*) n FROM nb_ip_addresses WHERE vrf_id = ?', r.id),
      prefix_count: count(ctx, 'SELECT COUNT(*) n FROM nb_prefixes WHERE vrf_id = ?', r.id),
    }),
  },
  {
    type: 'ipam.routetarget',
    app: 'ipam',
    path: 'route-targets',
    table: 'nb_route_targets',
    verbose: 'route target',
    verbosePlural: 'route targets',
    fields: [{ name: 'name', kind: 'string', required: true, maxLength: 21, search: true }, tenantF, descriptionF, commentsF],
    unique: [['name']],
    brief: ['name'],
    display: (r) => r.name,
    ordering: ['name'],
  },
  {
    type: 'ipam.rir',
    app: 'ipam',
    path: 'rirs',
    table: 'nb_rirs',
    verbose: 'RIR',
    verbosePlural: 'RIRs',
    fields: [nameF(), slugF, { name: 'is_private', kind: 'bool' }, descriptionF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['name'],
    serializeExtra: (r, ctx) => ({ aggregate_count: count(ctx, 'SELECT COUNT(*) n FROM nb_aggregates WHERE rir_id = ?', r.id) }),
  },
  {
    type: 'ipam.aggregate',
    app: 'ipam',
    path: 'aggregates',
    table: 'nb_aggregates',
    verbose: 'aggregate',
    verbosePlural: 'aggregates',
    fields: [
      { name: 'prefix', kind: 'cidr', required: true, search: true },
      { name: 'rir', kind: 'fk', ref: 'ipam.rir', required: true },
      tenantF,
      { name: 'date_added', kind: 'date' },
      descriptionF,
      commentsF,
    ],
    extraColumns: networkCols,
    indexes: ['family, start_hex, end_hex'],
    brief: ['prefix'],
    display: (r) => r.prefix,
    ordering: ['prefix'],
    orderExpr: { prefix: 't.family, t.start_hex, t.prefix_length' },
    filters: { family: familyFilter, prefix: within('start_hex', 'end_hex', false) },
    derive: (rec, errors) => deriveNetwork(rec, 'prefix', errors),
    validate(rec, errors, ctx) {
      if (rec.family == null) return;
      const other = ctx.db
        .prepare('SELECT prefix FROM nb_aggregates WHERE family = ? AND start_hex <= ? AND end_hex >= ? AND id IS NOT ?')
        .get(rec.family, rec.end_hex, rec.start_hex, rec.id ?? null) as Row | undefined;
      if (other) addError(errors, 'prefix', `Aggregates cannot overlap. ${rec.prefix} overlaps an existing aggregate (${other.prefix}).`);
    },
    serializeExtra: (r, ctx) => ({ family: familyObj(r.family), _utilization: aggregateUtilization(ctx, r) }),
  },
  {
    type: 'ipam.role',
    app: 'ipam',
    path: 'roles',
    table: 'nb_ipam_roles',
    verbose: 'role',
    verbosePlural: 'roles',
    fields: [nameF(), slugF, { name: 'weight', kind: 'int', default: 1000, min: 0, max: 32767 }, descriptionF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['weight', 'name'],
    serializeExtra: (r, ctx) => ({
      prefix_count: count(ctx, 'SELECT COUNT(*) n FROM nb_prefixes WHERE role_id = ?', r.id),
      vlan_count: count(ctx, 'SELECT COUNT(*) n FROM nb_vlans WHERE role_id = ?', r.id),
    }),
  },
  {
    type: 'ipam.prefix',
    app: 'ipam',
    path: 'prefixes',
    table: 'nb_prefixes',
    verbose: 'prefix',
    verbosePlural: 'prefixes',
    fields: [
      { name: 'prefix', kind: 'cidr', required: true, search: true },
      { name: 'vrf', kind: 'fk', ref: 'ipam.vrf' },
      { name: 'site', kind: 'fk', ref: 'dcim.site' },
      { name: 'scope_type', kind: 'string', maxLength: 50 },
      { name: 'scope_id', kind: 'int', min: 1 },
      tenantF,
      { name: 'vlan', kind: 'fk', ref: 'ipam.vlan' },
      { name: 'status', kind: 'choice', choices: PREFIX_STATUS, default: 'active', required: true },
      { name: 'role', kind: 'fk', ref: 'ipam.role', onDelete: 'setnull' },
      { name: 'is_pool', kind: 'bool' },
      { name: 'mark_utilized', kind: 'bool' },
      descriptionF,
      commentsF,
    ],
    extraColumns: networkCols,
    indexes: ['family, start_hex, end_hex'],
    brief: ['prefix'],
    display: (r) => r.prefix,
    ordering: ['prefix'],
    orderExpr: { prefix: 't.vrf_id IS NOT NULL, t.vrf_id, t.family, t.start_hex, t.prefix_length' },
    filters: {
      family: familyFilter,
      mask_length: maskFilter('='),
      mask_length__gte: maskFilter('>='),
      mask_length__lte: maskFilter('<='),
      within: within('start_hex', 'end_hex', true),
      parent: within('start_hex', 'end_hex', true),
      within_include: within('start_hex', 'end_hex', false),
      contains: (values) =>
        anyOf(values, (c) => ({
          sql: '(t.family = ? AND t.start_hex <= ? AND t.end_hex >= ? AND t.prefix_length <= ?)',
          params: [c.family, hexKey(c.network), hexKey(c.last), c.prefixLength],
        })),
      location_id: (values) => ({ sql: `(t.scope_type = 'dcim.location' AND t.scope_id IN (${ph(values)}))`, params: values.map(Number) }),
      region_id: (values) => ({
        sql: `((t.scope_type = 'dcim.region' AND t.scope_id IN (${regionTree(values.length)})) OR t.site_id IN (SELECT id FROM nb_sites WHERE region_id IN (${regionTree(values.length)})))`,
        params: [...values, ...values],
      }),
      depth: (values) => ({
        sql: `(SELECT COUNT(*) FROM nb_prefixes p WHERE p.family = t.family AND p.vrf_id IS t.vrf_id AND p.start_hex <= t.start_hex AND p.end_hex >= t.end_hex AND p.prefix_length < t.prefix_length) IN (${ph(values)})`,
        params: values.map(Number),
      }),
    },
    searchExtra(q) {
      const c = parseCidr(q, { allowHost: true });
      if (!c) return null;
      return { sql: '(t.family = ? AND t.start_hex <= ? AND t.end_hex >= ?)', params: [c.family, hexKey(c.network), hexKey(c.last)] };
    },
    derive(rec, errors, ctx, info) {
      deriveNetwork(rec, 'prefix', errors);
      deriveScope(rec, errors, ctx, info);
    },
    validate(rec, errors, ctx) {
      if (rec.family == null) return;
      if (rec.prefix_length === 0) addError(errors, 'prefix', 'Cannot create a prefix with a /0 mask.');
      if (vrfEnforces(ctx, rec.vrf_id)) {
        const dup = ctx.db.prepare('SELECT id FROM nb_prefixes WHERE vrf_id IS ? AND prefix = ? AND id IS NOT ?').get(rec.vrf_id, rec.prefix, rec.id ?? null);
        if (dup) addError(errors, 'prefix', `Duplicate prefix found in ${vrfName(ctx, rec.vrf_id)}: ${rec.prefix}`);
      }
      if (rec.vlan_id != null && rec.site_id != null) {
        const vlan = ctx.get('ipam.vlan', rec.vlan_id);
        if (vlan?.site_id != null && vlan.site_id !== rec.site_id) addError(errors, 'vlan', 'VLAN must belong to the same site as the prefix.');
      }
    },
    serializeExtra: (r, ctx) => ({
      family: familyObj(r.family),
      scope: r.scope_type ? ctx.ref(r.scope_type, r.scope_id) : null,
      _depth: prefixDepth(ctx, r),
      _children: prefixChildren(ctx, r),
      _utilization: prefixUtilization(ctx, r),
    }),
  },
  {
    type: 'ipam.iprange',
    app: 'ipam',
    path: 'ip-ranges',
    table: 'nb_ip_ranges',
    verbose: 'IP range',
    verbosePlural: 'IP ranges',
    fields: [
      { name: 'start_address', kind: 'ipaddr', required: true, search: true },
      { name: 'end_address', kind: 'ipaddr', required: true, search: true },
      { name: 'vrf', kind: 'fk', ref: 'ipam.vrf' },
      tenantF,
      { name: 'status', kind: 'choice', choices: VLAN_STATUS, default: 'active', required: true },
      { name: 'role', kind: 'fk', ref: 'ipam.role', onDelete: 'setnull' },
      descriptionF,
      commentsF,
      { name: 'mark_populated', kind: 'bool' },
      { name: 'mark_utilized', kind: 'bool' },
    ],
    extraColumns: networkCols,
    brief: ['start_address', 'end_address'],
    display: (r) => `${r.start_address}-${r.end_address}`,
    ordering: ['start_address'],
    orderExpr: { start_address: 't.vrf_id IS NOT NULL, t.vrf_id, t.family, t.start_hex', end_address: 't.family, t.end_hex' },
    filters: { family: familyFilter, parent: within('start_hex', 'end_hex', false) },
    derive(rec, errors) {
      const s = rec.start_address != null ? parseCidr(rec.start_address, { allowHost: true }) : null;
      const e = rec.end_address != null ? parseCidr(rec.end_address, { allowHost: true }) : null;
      if (rec.start_address != null && !s) addError(errors, 'start_address', 'Enter a valid IP address.');
      if (rec.end_address != null && !e) addError(errors, 'end_address', 'Enter a valid IP address.');
      if (!s || !e) return;
      rec.start_address = ifaceToString(s);
      rec.end_address = ifaceToString(e);
      if (s.family !== e.family) addError(errors, 'end_address', 'Starting and ending addresses must be of the same family.');
      else if (s.prefixLength !== e.prefixLength) addError(errors, 'end_address', 'Starting and ending address masks must match.');
      else if (e.address < s.address) addError(errors, 'end_address', 'Ending address must be greater than the starting address.');
      rec.family = s.family;
      rec.start_hex = hexKey(s.address);
      rec.end_hex = hexKey(e.address);
      rec.prefix_length = s.prefixLength;
    },
    validate(rec, errors, ctx) {
      if (rec.family == null || errors.end_address) return;
      const other = ctx.db
        .prepare('SELECT start_address, end_address FROM nb_ip_ranges WHERE family = ? AND vrf_id IS ? AND start_hex <= ? AND end_hex >= ? AND id IS NOT ?')
        .get(rec.family, rec.vrf_id, rec.end_hex, rec.start_hex, rec.id ?? null) as Row | undefined;
      if (other) addError(errors, 'start_address', `Defined addresses overlap with range ${other.start_address}-${other.end_address} in ${vrfName(ctx, rec.vrf_id)}.`);
    },
    serializeExtra(r) {
      const n = BigInt(`0x${r.end_hex}`) - BigInt(`0x${r.start_hex}`) + 1n;
      return { family: familyObj(r.family), size: n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString() };
    },
  },
  {
    type: 'ipam.ipaddress',
    app: 'ipam',
    path: 'ip-addresses',
    table: 'nb_ip_addresses',
    verbose: 'IP address',
    verbosePlural: 'IP addresses',
    fields: [
      { name: 'address', kind: 'ipaddr', required: true, search: true },
      { name: 'vrf', kind: 'fk', ref: 'ipam.vrf' },
      tenantF,
      { name: 'status', kind: 'choice', choices: IP_STATUS, default: 'active', required: true },
      { name: 'role', kind: 'choice', choices: IP_ROLES },
      { name: 'assigned_object_type', kind: 'string' },
      { name: 'assigned_object_id', kind: 'int', min: 1 },
      { name: 'nat_inside', kind: 'fk', ref: 'ipam.ipaddress', onDelete: 'setnull' },
      { name: 'dns_name', kind: 'string', maxLength: 255, search: true },
      descriptionF,
      commentsF,
    ],
    extraColumns: { family: 'INTEGER', host_hex: 'TEXT', prefix_length: 'INTEGER' },
    indexes: ['family, host_hex', 'assigned_object_type, assigned_object_id'],
    brief: ['address'],
    display: (r) => r.address,
    ordering: ['address'],
    orderExpr: { address: 't.family, t.host_hex, t.prefix_length' },
    filters: {
      family: familyFilter,
      mask_length: maskFilter('='),
      parent: (values) =>
        anyOf(values, (c) => ({ sql: '(t.family = ? AND t.host_hex >= ? AND t.host_hex <= ?)', params: [c.family, hexKey(c.network), hexKey(c.last)] })),
      interface_id: (values) => ({ sql: `(t.assigned_object_type = 'dcim.interface' AND t.assigned_object_id IN (${ph(values)}))`, params: values.map(Number) }),
      vminterface_id: (values) => ({ sql: `(t.assigned_object_type = 'virtualization.vminterface' AND t.assigned_object_id IN (${ph(values)}))`, params: values.map(Number) }),
      virtual_machine_id: (values) => vmIface(values, 'id'),
      virtual_machine: (values) => vmIface(values, 'name'),
      device_id: (values) => ifaceDevice(values, 'id'),
      device: (values) => ifaceDevice(values, 'name'),
      site_id: (values) => ifaceDevice(values, 'site_id'),
      assigned_to_interface: (values) => ({
        sql: ['true', '1'].includes(values[0]) ? 't.assigned_object_id IS NOT NULL' : 't.assigned_object_id IS NULL',
        params: [],
      }),
    },
    searchExtra(q) {
      const ip = parseIp(q.split('/')[0]);
      return ip ? { sql: '(t.family = ? AND t.host_hex = ?)', params: [ip.family, hexKey(ip.value)] } : null;
    },
    derive(rec, errors) {
      if (rec.address != null) {
        const c = parseCidr(rec.address, { allowHost: true });
        if (!c) addError(errors, 'address', 'Enter a valid IPv4 or IPv6 address with optional mask, e.g. 10.0.0.1/24.');
        else {
          rec.address = ifaceToString(c);
          rec.family = c.family;
          rec.host_hex = hexKey(c.address);
          rec.prefix_length = c.prefixLength;
          if (c.prefixLength === 0) addError(errors, 'address', 'Cannot create an IP address with a /0 mask.');
        }
      }
      if (rec.assigned_object_id != null && rec.assigned_object_type == null) rec.assigned_object_type = 'dcim.interface';
      if (rec.assigned_object_id == null) rec.assigned_object_type = null;
      if (rec.dns_name === '') rec.dns_name = null;
    },
    validate(rec, errors, ctx) {
      if (rec.assigned_object_type != null) {
        if (!ASSIGNABLE.includes(rec.assigned_object_type)) addError(errors, 'assigned_object_type', `Must be one of ${ASSIGNABLE.join(', ')}.`);
        else if (!ctx.get(rec.assigned_object_type, rec.assigned_object_id)) addError(errors, 'assigned_object_id', `${rec.assigned_object_type} ${rec.assigned_object_id} not found.`);
      }
      if (rec.dns_name != null && !/^([0-9A-Za-z_-]+|\*)(\.[0-9A-Za-z_-]+)*\.?$/.test(rec.dns_name)) {
        addError(errors, 'dns_name', 'Only alphanumeric characters, asterisks, hyphens, periods, and underscores are allowed in DNS names.');
      }
      if (rec.family == null || SHARED_ROLES.includes(rec.role)) return;
      if (vrfEnforces(ctx, rec.vrf_id)) {
        const dup = ctx.db
          .prepare(`SELECT address FROM nb_ip_addresses WHERE vrf_id IS ? AND family = ? AND host_hex = ? AND id IS NOT ? AND (role IS NULL OR role NOT IN (${ph(SHARED_ROLES)}))`)
          .get(rec.vrf_id, rec.family, rec.host_hex, rec.id ?? null, ...SHARED_ROLES) as Row | undefined;
        if (dup) addError(errors, 'address', `Duplicate IP address found in ${vrfName(ctx, rec.vrf_id)}: ${dup.address}`);
      }
    },
    afterWrite(row, ctx, info) {
      // An IP moved away from a device can no longer be that device's primary IP.
      const iface = row.assigned_object_type === 'dcim.interface' ? ctx.get('dcim.interface', row.assigned_object_id) : null;
      const vmIfaceRow = row.assigned_object_type === 'virtualization.vminterface' ? ctx.get('virtualization.vminterface', row.assigned_object_id) : null;
      const deviceId = iface?.device_id ?? null;
      const vmId = vmIfaceRow?.virtual_machine_id ?? null;
      if (info.existing) {
        for (const col of ['primary_ip4_id', 'primary_ip6_id']) {
          ctx.db.prepare(`UPDATE nb_devices SET ${col} = NULL WHERE ${col} = ? AND id IS NOT ?`).run(row.id, deviceId);
          ctx.db.prepare(`UPDATE nb_virtual_machines SET ${col} = NULL WHERE ${col} = ? AND id IS NOT ?`).run(row.id, vmId);
        }
        ctx.invalidate();
      }
    },
    serializeExtra(r, ctx) {
      return {
        family: familyObj(r.family),
        assigned_object: ASSIGNABLE.includes(r.assigned_object_type) ? ctx.ref(r.assigned_object_type, r.assigned_object_id) : null,
      };
    },
  },
  {
    type: 'ipam.vlangroup',
    app: 'ipam',
    path: 'vlan-groups',
    table: 'nb_vlan_groups',
    verbose: 'VLAN group',
    verbosePlural: 'VLAN groups',
    fields: [
      nameF(),
      slugF,
      { name: 'site', kind: 'fk', ref: 'dcim.site', onDelete: 'cascade' },
      { name: 'min_vid', kind: 'int', min: 1, max: 4094, default: 1, required: true },
      { name: 'max_vid', kind: 'int', min: 1, max: 4094, default: 4094, required: true },
      descriptionF,
    ],
    unique: [['site', 'name'], ['site', 'slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['name'],
    validate(rec, errors, ctx) {
      if (rec.min_vid != null && rec.max_vid != null && rec.min_vid > rec.max_vid) addError(errors, 'max_vid', 'Maximum VID must be greater than or equal to the minimum VID.');
      if (rec.id != null) {
        const out = ctx.db.prepare('SELECT vid FROM nb_vlans WHERE group_id = ? AND (vid < ? OR vid > ?) LIMIT 1').get(rec.id, rec.min_vid, rec.max_vid) as Row | undefined;
        if (out) addError(errors, 'min_vid', `VLAN ${out.vid} in this group would fall outside the range.`);
      }
    },
    serializeExtra(r, ctx) {
      const n = count(ctx, 'SELECT COUNT(*) n FROM nb_vlans WHERE group_id = ?', r.id);
      const total = r.max_vid - r.min_vid + 1;
      return { vlan_count: n, utilization: total > 0 ? Math.round((n / total) * 1000) / 10 : 0 };
    },
  },
  {
    type: 'ipam.vlan',
    app: 'ipam',
    path: 'vlans',
    table: 'nb_vlans',
    verbose: 'VLAN',
    verbosePlural: 'VLANs',
    fields: [
      { name: 'site', kind: 'fk', ref: 'dcim.site' },
      { name: 'group', kind: 'fk', ref: 'ipam.vlangroup' },
      { name: 'vid', kind: 'int', required: true, min: 1, max: 4094 },
      nameF(64),
      tenantF,
      { name: 'status', kind: 'choice', choices: VLAN_STATUS, default: 'active', required: true },
      { name: 'role', kind: 'fk', ref: 'ipam.role', onDelete: 'setnull' },
      descriptionF,
      commentsF,
    ],
    brief: ['vid', 'name'],
    display: (r) => `${r.name} (${r.vid})`,
    ordering: ['site', 'group', 'vid'],
    validate(rec, errors, ctx) {
      if (rec.vid == null) return;
      if (rec.group_id != null) {
        const g = ctx.get('ipam.vlangroup', rec.group_id);
        if (g) {
          if (rec.vid < g.min_vid || rec.vid > g.max_vid) addError(errors, 'vid', `VID must be between ${g.min_vid} and ${g.max_vid} for VLANs in group ${g.name}.`);
          if (g.site_id != null && rec.site_id != null && g.site_id !== rec.site_id) addError(errors, 'site', `VLAN group ${g.name} belongs to a different site.`);
        }
        const dupVid = ctx.db.prepare('SELECT id FROM nb_vlans WHERE group_id = ? AND vid = ? AND id IS NOT ?').get(rec.group_id, rec.vid, rec.id ?? null);
        if (dupVid) addError(errors, 'vid', `VLAN with VID ${rec.vid} already exists in this group.`);
        const dupName = ctx.db.prepare('SELECT id FROM nb_vlans WHERE group_id = ? AND lower(name) = lower(?) AND id IS NOT ?').get(rec.group_id, rec.name, rec.id ?? null);
        if (dupName) addError(errors, 'name', `VLAN named ${rec.name} already exists in this group.`);
      } else {
        const dup = ctx.db.prepare('SELECT id FROM nb_vlans WHERE group_id IS NULL AND site_id IS ? AND vid = ? AND id IS NOT ?').get(rec.site_id, rec.vid, rec.id ?? null);
        if (dup) addError(errors, 'vid', `VLAN with VID ${rec.vid} already exists ${rec.site_id == null ? 'globally' : 'at this site'}.`);
      }
    },
    serializeExtra: (r, ctx) => ({
      prefix_count: count(ctx, 'SELECT COUNT(*) n FROM nb_prefixes WHERE vlan_id = ?', r.id),
    }),
  },
];

