import type { Ctx, Errors, ModelDef, Row } from '../types.js';
import { choices } from '../types.js';
import { addError, commentsF, count, descriptionF, nameF, slugF, tenantF } from './common.js';

const CLUSTER_STATUS = choices('planned', 'staging', 'active', 'decommissioning', 'offline');
const VM_STATUS = choices('offline', 'active', 'planned', 'staged', 'failed', 'decommissioning');
const IFACE_MODES = choices('access', ['tagged', 'Tagged'], ['tagged-all', 'Tagged (All)']);

const ph = (values: unknown[]) => values.map(() => '?').join(',');

/** Clusters must have a unique name within their group and within their site (or globally when they have neither). */
function checkClusterName(ctx: Ctx, rec: Row, errors: Errors) {
  if (!rec.name) return;
  const dup = (where: string, ...params: unknown[]) =>
    ctx.db.prepare(`SELECT id FROM nb_clusters WHERE lower(name) = lower(?) AND ${where} AND id IS NOT ?`).get(rec.name, ...params, rec.id ?? null);
  if (rec.group_id != null && dup('group_id = ?', rec.group_id)) addError(errors, 'name', 'A cluster with this name already exists in the group.');
  else if (rec.site_id != null && dup('site_id = ?', rec.site_id)) addError(errors, 'name', 'A cluster with this name already exists at the site.');
  else if (rec.group_id == null && rec.site_id == null && dup('group_id IS NULL AND site_id IS NULL')) addError(errors, 'name', 'A cluster with this name already exists.');
}

export const virtualizationModels: ModelDef[] = [
  {
    type: 'virtualization.clustertype',
    app: 'virtualization',
    path: 'cluster-types',
    table: 'nb_cluster_types',
    verbose: 'cluster type',
    verbosePlural: 'cluster types',
    fields: [nameF(), slugF, descriptionF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['name'],
    serializeExtra: (r, ctx) => ({ cluster_count: count(ctx, 'SELECT COUNT(*) n FROM nb_clusters WHERE type_id = ?', r.id) }),
  },
  {
    type: 'virtualization.clustergroup',
    app: 'virtualization',
    path: 'cluster-groups',
    table: 'nb_cluster_groups',
    verbose: 'cluster group',
    verbosePlural: 'cluster groups',
    fields: [nameF(), slugF, descriptionF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['name'],
    serializeExtra: (r, ctx) => ({ cluster_count: count(ctx, 'SELECT COUNT(*) n FROM nb_clusters WHERE group_id = ?', r.id) }),
  },
  {
    type: 'virtualization.cluster',
    app: 'virtualization',
    path: 'clusters',
    table: 'nb_clusters',
    verbose: 'cluster',
    verbosePlural: 'clusters',
    fields: [
      nameF(),
      { name: 'type', kind: 'fk', ref: 'virtualization.clustertype', required: true },
      { name: 'group', kind: 'fk', ref: 'virtualization.clustergroup', onDelete: 'setnull' },
      { name: 'status', kind: 'choice', choices: CLUSTER_STATUS, default: 'active', required: true },
      tenantF,
      { name: 'site', kind: 'fk', ref: 'dcim.site' },
      descriptionF,
      commentsF,
    ],
    brief: ['name'],
    display: (r) => r.name,
    ordering: ['group', 'name'],
    validate(rec, errors, ctx, info) {
      checkClusterName(ctx, rec, errors);
      if (info.existing && rec.site_id != null && rec.site_id !== info.existing.site_id) {
        const other = ctx.db.prepare('SELECT name FROM nb_devices WHERE cluster_id = ? AND site_id != ? LIMIT 1').get(rec.id, rec.site_id) as Row | undefined;
        if (other) addError(errors, 'site', `${other.name ?? 'A device'} in this cluster belongs to another site.`);
        const vm = ctx.db.prepare('SELECT name FROM nb_virtual_machines WHERE cluster_id = ? AND site_id IS NOT ? LIMIT 1').get(rec.id, rec.site_id) as Row | undefined;
        if (vm) addError(errors, 'site', `Virtual machine ${vm.name} in this cluster belongs to another site.`);
      }
    },
    serializeExtra: (r, ctx) => ({
      device_count: count(ctx, 'SELECT COUNT(*) n FROM nb_devices WHERE cluster_id = ?', r.id),
      virtualmachine_count: count(ctx, 'SELECT COUNT(*) n FROM nb_virtual_machines WHERE cluster_id = ?', r.id),
    }),
  },
  {
    type: 'virtualization.virtualmachine',
    app: 'virtualization',
    path: 'virtual-machines',
    table: 'nb_virtual_machines',
    verbose: 'virtual machine',
    verbosePlural: 'virtual machines',
    fields: [
      { name: 'name', kind: 'string', required: true, maxLength: 64, search: true },
      { name: 'status', kind: 'choice', choices: VM_STATUS, default: 'active', required: true },
      { name: 'site', kind: 'fk', ref: 'dcim.site' },
      { name: 'cluster', kind: 'fk', ref: 'virtualization.cluster' },
      { name: 'device', kind: 'fk', ref: 'dcim.device', onDelete: 'setnull' },
      { name: 'role', kind: 'fk', ref: 'dcim.devicerole', onDelete: 'setnull' },
      tenantF,
      { name: 'platform', kind: 'fk', ref: 'dcim.platform', onDelete: 'setnull' },
      { name: 'primary_ip4', kind: 'fk', ref: 'ipam.ipaddress', onDelete: 'setnull' },
      { name: 'primary_ip6', kind: 'fk', ref: 'ipam.ipaddress', onDelete: 'setnull' },
      { name: 'vcpus', kind: 'float', min: 0.01, max: 10000 },
      { name: 'memory', kind: 'int', min: 0 },
      { name: 'disk', kind: 'int', min: 0 },
      { name: 'serial', kind: 'string', maxLength: 50, search: true },
      descriptionF,
      commentsF,
    ],
    brief: ['name'],
    display: (r) => r.name,
    ordering: ['name'],
    filters: {
      has_primary_ip: (values) => ({
        sql: ['true', '1'].includes(values[0]) ? '(t.primary_ip4_id IS NOT NULL OR t.primary_ip6_id IS NOT NULL)' : '(t.primary_ip4_id IS NULL AND t.primary_ip6_id IS NULL)',
        params: [],
      }),
      cluster_group_id: (values) => ({ sql: `t.cluster_id IN (SELECT id FROM nb_clusters WHERE group_id IN (${ph(values)}))`, params: values }),
      cluster_type_id: (values) => ({ sql: `t.cluster_id IN (SELECT id FROM nb_clusters WHERE type_id IN (${ph(values)}))`, params: values }),
    },
    derive(rec, _errors, ctx) {
      if (rec.site_id == null && rec.cluster_id != null) rec.site_id = ctx.get('virtualization.cluster', rec.cluster_id)?.site_id ?? null;
    },
    validate(rec, errors, ctx) {
      if (rec.site_id == null && rec.cluster_id == null) addError(errors, 'cluster', 'A virtual machine must be assigned to a site and/or cluster.');
      const cluster = rec.cluster_id != null ? ctx.get('virtualization.cluster', rec.cluster_id) : null;
      if (cluster?.site_id != null && rec.site_id != null && cluster.site_id !== rec.site_id) {
        addError(errors, 'cluster', `The selected cluster (${cluster.name}) is not assigned to this site.`);
      }
      if (rec.device_id != null) {
        const dev = ctx.get('dcim.device', rec.device_id);
        if (!cluster) addError(errors, 'device', 'Must specify a cluster when assigning a host device.');
        else if (dev && dev.cluster_id !== cluster.id) addError(errors, 'device', `The selected device (${dev.name}) is not assigned to this cluster (${cluster.name}).`);
      }
      if (rec.role_id != null) {
        const role = ctx.get('dcim.devicerole', rec.role_id);
        if (role && !role.vm_role) addError(errors, 'role', `Role ${role.name} is not allowed for virtual machines (vm_role is off).`);
      }
      if (rec.name) {
        const dup = ctx.db
          .prepare('SELECT id FROM nb_virtual_machines WHERE lower(name) = lower(?) AND cluster_id IS ? AND tenant_id IS ? AND (cluster_id IS NOT NULL OR site_id IS ?) AND id IS NOT ?')
          .get(rec.name, rec.cluster_id, rec.tenant_id, rec.site_id, rec.id ?? null);
        if (dup) addError(errors, 'name', `A virtual machine named ${rec.name} already exists ${rec.cluster_id != null ? 'in this cluster' : 'at this site'}.`);
      }
      for (const [field, fam] of [['primary_ip4', 4], ['primary_ip6', 6]] as const) {
        const ipId = rec[`${field}_id`];
        if (ipId == null) continue;
        const ip = ctx.get('ipam.ipaddress', ipId);
        if (!ip) continue;
        if (ip.family !== fam) addError(errors, field, `${ip.address} is not an IPv${fam} address.`);
        const iface = ip.assigned_object_type === 'virtualization.vminterface' ? ctx.get('virtualization.vminterface', ip.assigned_object_id) : null;
        if (!iface || iface.virtual_machine_id !== rec.id) addError(errors, field, `The specified IP address (${ip.address}) is not assigned to this VM.`);
      }
    },
    beforeDelete(row, ctx) {
      ctx.db.prepare('UPDATE nb_virtual_machines SET primary_ip4_id = NULL, primary_ip6_id = NULL WHERE id = ?').run(row.id);
      ctx.invalidate();
    },
    serializeExtra: (r, ctx) => ({
      primary_ip: ctx.ref('ipam.ipaddress', r.primary_ip4_id ?? r.primary_ip6_id),
      interface_count: count(ctx, 'SELECT COUNT(*) n FROM nb_vm_interfaces WHERE virtual_machine_id = ?', r.id),
    }),
  },
  {
    type: 'virtualization.vminterface',
    app: 'virtualization',
    path: 'interfaces',
    table: 'nb_vm_interfaces',
    verbose: 'interface',
    verbosePlural: 'interfaces',
    fields: [
      { name: 'virtual_machine', kind: 'fk', ref: 'virtualization.virtualmachine', required: true, onDelete: 'cascade' },
      nameF(64),
      { name: 'enabled', kind: 'bool', default: true },
      { name: 'parent', kind: 'fk', ref: 'virtualization.vminterface', onDelete: 'setnull' },
      { name: 'bridge', kind: 'fk', ref: 'virtualization.vminterface', onDelete: 'setnull' },
      { name: 'mtu', kind: 'int', min: 1, max: 65536 },
      { name: 'mac_address', kind: 'mac', search: true },
      descriptionF,
      { name: 'mode', kind: 'choice', choices: IFACE_MODES },
      { name: 'untagged_vlan', kind: 'fk', ref: 'ipam.vlan', onDelete: 'setnull' },
      { name: 'tagged_vlans', kind: 'm2m', ref: 'ipam.vlan' },
      { name: 'vrf', kind: 'fk', ref: 'ipam.vrf', onDelete: 'setnull' },
    ],
    unique: [['virtual_machine', 'name']],
    brief: ['virtual_machine', 'name'],
    display: (r) => r.name,
    ordering: ['virtual_machine', 'name'],
    filters: {
      cluster_id: (values) => ({ sql: `t.virtual_machine_id IN (SELECT id FROM nb_virtual_machines WHERE cluster_id IN (${ph(values)}))`, params: values }),
      vlan_id: (values) => ({
        sql: `(t.untagged_vlan_id IN (${ph(values)}) OR t.id IN (SELECT src_id FROM nb_m2m WHERE field = 'virtualization.vminterface.tagged_vlans' AND dst_id IN (${ph(values)})))`,
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
      for (const field of ['parent', 'bridge'] as const) {
        const id = rec[`${field}_id`];
        if (id == null) continue;
        if (id === rec.id) addError(errors, field, `An interface cannot be its own ${field}.`);
        const other = ctx.get('virtualization.vminterface', id);
        if (other && other.virtual_machine_id !== rec.virtual_machine_id) addError(errors, field, `The selected ${field} interface belongs to a different virtual machine.`);
      }
      if (info.existing && info.existing.virtual_machine_id !== rec.virtual_machine_id) addError(errors, 'virtual_machine', 'Interfaces cannot be moved to another virtual machine.');
      const vm = ctx.get('virtualization.virtualmachine', rec.virtual_machine_id);
      for (const vid of [rec.untagged_vlan_id, ...(info.m2m.tagged_vlans ?? [])].filter((v) => v != null)) {
        const vlan = ctx.get('ipam.vlan', vid);
        if (vlan && vlan.site_id != null && vm && vlan.site_id !== vm.site_id) {
          addError(errors, vid === rec.untagged_vlan_id ? 'untagged_vlan' : 'tagged_vlans', `VLAN ${vlan.name} (${vlan.vid}) must be global or belong to the virtual machine's site.`);
        }
      }
    },
    beforeDelete(row, ctx) {
      ctx.db.prepare("UPDATE nb_virtual_machines SET primary_ip4_id = NULL WHERE primary_ip4_id IN (SELECT id FROM nb_ip_addresses WHERE assigned_object_type = 'virtualization.vminterface' AND assigned_object_id = ?)").run(row.id);
      ctx.db.prepare("UPDATE nb_virtual_machines SET primary_ip6_id = NULL WHERE primary_ip6_id IN (SELECT id FROM nb_ip_addresses WHERE assigned_object_type = 'virtualization.vminterface' AND assigned_object_id = ?)").run(row.id);
      ctx.db.prepare("UPDATE nb_ip_addresses SET assigned_object_type = NULL, assigned_object_id = NULL WHERE assigned_object_type = 'virtualization.vminterface' AND assigned_object_id = ?").run(row.id);
      ctx.invalidate();
    },
    serializeExtra: (r, ctx) => ({
      count_ipaddresses: count(ctx, "SELECT COUNT(*) n FROM nb_ip_addresses WHERE assigned_object_type = 'virtualization.vminterface' AND assigned_object_id = ?", r.id),
    }),
  },
];
