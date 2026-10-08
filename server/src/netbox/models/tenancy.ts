import type { ModelDef } from '../types.js';
import { checkTreeCycle, commentsF, count, descriptionF, nameF, slugF, treeDepth } from './common.js';

export const tenancyModels: ModelDef[] = [
  {
    type: 'tenancy.tenantgroup',
    app: 'tenancy',
    path: 'tenant-groups',
    table: 'nb_tenant_groups',
    verbose: 'tenant group',
    verbosePlural: 'tenant groups',
    fields: [nameF(), slugF, { name: 'parent', kind: 'fk', ref: 'tenancy.tenantgroup', onDelete: 'cascade' }, descriptionF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['name'],
    validate: (rec, errors, ctx) => checkTreeCycle(ctx, 'tenancy.tenantgroup', rec, errors),
    serializeExtra: (r, ctx) => ({
      _depth: treeDepth(ctx, 'tenancy.tenantgroup', r),
      tenant_count: count(ctx, 'SELECT COUNT(*) n FROM nb_tenants WHERE group_id = ?', r.id),
    }),
  },
  {
    type: 'tenancy.tenant',
    app: 'tenancy',
    path: 'tenants',
    table: 'nb_tenants',
    verbose: 'tenant',
    verbosePlural: 'tenants',
    fields: [nameF(), slugF, { name: 'group', kind: 'fk', ref: 'tenancy.tenantgroup', onDelete: 'setnull' }, descriptionF, commentsF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['name'],
    serializeExtra: (r, ctx) => ({
      site_count: count(ctx, 'SELECT COUNT(*) n FROM nb_sites WHERE tenant_id = ?', r.id),
      device_count: count(ctx, 'SELECT COUNT(*) n FROM nb_devices WHERE tenant_id = ?', r.id),
      prefix_count: count(ctx, 'SELECT COUNT(*) n FROM nb_prefixes WHERE tenant_id = ?', r.id),
      ipaddress_count: count(ctx, 'SELECT COUNT(*) n FROM nb_ip_addresses WHERE tenant_id = ?', r.id),
    }),
  },
];
