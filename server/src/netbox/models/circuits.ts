import { connectionFields } from '../cabling.js';
import type { ModelDef, Row } from '../types.js';
import { choices } from '../types.js';
import { addError, colorF, commentsF, count, descriptionF, nameF, slugF, tenantF } from './common.js';

const CIRCUIT_STATUS = choices('planned', 'provisioning', 'active', 'offline', 'deprovisioning', 'decommissioned');

export const circuitsModels: ModelDef[] = [
  {
    type: 'circuits.provider',
    app: 'circuits',
    path: 'providers',
    table: 'nb_providers',
    verbose: 'provider',
    verbosePlural: 'providers',
    fields: [nameF(), slugF, descriptionF, commentsF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['name'],
    serializeExtra: (r, ctx) => ({
      circuit_count: count(ctx, 'SELECT COUNT(*) n FROM nb_circuits WHERE provider_id = ?', r.id),
      account_count: count(ctx, 'SELECT COUNT(*) n FROM nb_provider_accounts WHERE provider_id = ?', r.id),
    }),
  },
  {
    type: 'circuits.provideraccount',
    app: 'circuits',
    path: 'provider-accounts',
    table: 'nb_provider_accounts',
    verbose: 'provider account',
    verbosePlural: 'provider accounts',
    fields: [
      { name: 'provider', kind: 'fk', ref: 'circuits.provider', required: true },
      { name: 'account', kind: 'string', required: true, maxLength: 100, search: true },
      { name: 'name', kind: 'string', maxLength: 100, search: true },
      descriptionF,
      commentsF,
    ],
    unique: [['provider', 'account']],
    brief: ['name', 'account'],
    display: (r) => (r.name ? `${r.name} (${r.account})` : r.account),
    ordering: ['provider', 'account'],
    validate(rec, errors, ctx) {
      if (!rec.name) return;
      const dup = ctx.db.prepare('SELECT id FROM nb_provider_accounts WHERE provider_id = ? AND lower(name) = lower(?) AND id IS NOT ?').get(rec.provider_id, rec.name, rec.id ?? null);
      if (dup) addError(errors, 'name', 'Provider account with this provider and name already exists.');
    },
  },
  {
    type: 'circuits.providernetwork',
    app: 'circuits',
    path: 'provider-networks',
    table: 'nb_provider_networks',
    verbose: 'provider network',
    verbosePlural: 'provider networks',
    fields: [
      { name: 'provider', kind: 'fk', ref: 'circuits.provider', required: true },
      nameF(),
      { name: 'service_id', kind: 'string', maxLength: 100, search: true },
      descriptionF,
      commentsF,
    ],
    unique: [['provider', 'name']],
    brief: ['name'],
    display: (r) => r.name,
    ordering: ['provider', 'name'],
  },
  {
    type: 'circuits.circuittype',
    app: 'circuits',
    path: 'circuit-types',
    table: 'nb_circuit_types',
    verbose: 'circuit type',
    verbosePlural: 'circuit types',
    fields: [nameF(), slugF, colorF(''), descriptionF],
    unique: [['name'], ['slug']],
    brief: ['name', 'slug'],
    display: (r) => r.name,
    ordering: ['name'],
    derive(rec) {
      if (rec.color === '') rec.color = null;
    },
    serializeExtra: (r, ctx) => ({ circuit_count: count(ctx, 'SELECT COUNT(*) n FROM nb_circuits WHERE type_id = ?', r.id) }),
  },
  {
    type: 'circuits.circuit',
    app: 'circuits',
    path: 'circuits',
    table: 'nb_circuits',
    verbose: 'circuit',
    verbosePlural: 'circuits',
    fields: [
      { name: 'cid', kind: 'string', required: true, maxLength: 100, search: true },
      { name: 'provider', kind: 'fk', ref: 'circuits.provider', required: true },
      { name: 'provider_account', kind: 'fk', ref: 'circuits.provideraccount', onDelete: 'setnull' },
      { name: 'type', kind: 'fk', ref: 'circuits.circuittype', required: true },
      { name: 'status', kind: 'choice', choices: CIRCUIT_STATUS, default: 'active', required: true },
      tenantF,
      { name: 'install_date', kind: 'date' },
      { name: 'termination_date', kind: 'date' },
      { name: 'commit_rate', kind: 'int', min: 0 },
      descriptionF,
      commentsF,
    ],
    unique: [['provider', 'cid']],
    brief: ['cid', 'provider'],
    display: (r) => r.cid,
    ordering: ['provider', 'cid'],
    filters: {
      site_id: (values) => ({ sql: `t.id IN (SELECT circuit_id FROM nb_circuit_terminations WHERE site_id IN (${values.map(() => '?').join(',')}))`, params: values }),
      provider_network_id: (values) => ({
        sql: `t.id IN (SELECT circuit_id FROM nb_circuit_terminations WHERE provider_network_id IN (${values.map(() => '?').join(',')}))`,
        params: values,
      }),
    },
    validate(rec, errors, ctx) {
      if (rec.provider_account_id != null) {
        const acc = ctx.get('circuits.provideraccount', rec.provider_account_id);
        if (acc && acc.provider_id !== rec.provider_id) addError(errors, 'provider_account', 'The provider account must belong to the circuit provider.');
      }
      if (rec.install_date && rec.termination_date && rec.termination_date < rec.install_date) {
        addError(errors, 'termination_date', 'The termination date cannot be before the installation date.');
      }
    },
    serializeExtra(r, ctx) {
      const term = (side: string) => {
        const t = ctx.db.prepare('SELECT id FROM nb_circuit_terminations WHERE circuit_id = ? AND term_side = ?').get(r.id, side) as Row | undefined;
        return t ? ctx.serialize('circuits.circuittermination', ctx.get('circuits.circuittermination', t.id)!) : null;
      };
      const brief = (o: Record<string, unknown> | null) =>
        o && { id: o.id, url: o.url, display: o.display, site: o.site, provider_network: o.provider_network, port_speed: o.port_speed, upstream_speed: o.upstream_speed, xconnect_id: o.xconnect_id, description: o.description, cable: o.cable };
      return { termination_a: brief(term('A')), termination_z: brief(term('Z')) };
    },
  },
  {
    type: 'circuits.circuittermination',
    app: 'circuits',
    path: 'circuit-terminations',
    table: 'nb_circuit_terminations',
    verbose: 'circuit termination',
    verbosePlural: 'circuit terminations',
    fields: [
      { name: 'circuit', kind: 'fk', ref: 'circuits.circuit', required: true, onDelete: 'cascade' },
      { name: 'term_side', kind: 'choice', choices: choices(['A', 'A'], ['Z', 'Z']), required: true },
      { name: 'site', kind: 'fk', ref: 'dcim.site' },
      { name: 'provider_network', kind: 'fk', ref: 'circuits.providernetwork' },
      { name: 'port_speed', kind: 'int', min: 0 },
      { name: 'upstream_speed', kind: 'int', min: 0 },
      { name: 'xconnect_id', kind: 'string', maxLength: 50, search: true },
      { name: 'pp_info', kind: 'string', maxLength: 100 },
      descriptionF,
      { name: 'mark_connected', kind: 'bool' },
      { name: 'cable', kind: 'fk', ref: 'dcim.cable', readOnly: true, onDelete: 'setnull' },
      { name: 'cable_end', kind: 'string', readOnly: true },
    ],
    unique: [['circuit', 'term_side']],
    brief: ['circuit', 'term_side', 'cable'],
    display: (r, ctx) => `${ctx.get('circuits.circuit', r.circuit_id)?.cid ?? r.circuit_id}: Termination ${r.term_side}`,
    ordering: ['circuit', 'term_side'],
    filters: {
      provider_id: (values) => ({ sql: `t.circuit_id IN (SELECT id FROM nb_circuits WHERE provider_id IN (${values.map(() => '?').join(',')}))`, params: values }),
      cabled: (values) => ({ sql: ['true', '1'].includes(values[0]) ? 't.cable_id IS NOT NULL' : 't.cable_id IS NULL', params: [] }),
    },
    validate(rec, errors, ctx, info) {
      const both = rec.site_id != null && rec.provider_network_id != null;
      if (both) addError(errors, 'provider_network', 'A circuit termination cannot attach to both a site and a provider network.');
      else if (rec.site_id == null && rec.provider_network_id == null) addError(errors, 'site', 'A circuit termination must attach to either a site or a provider network.');
      if (rec.provider_network_id != null && rec.cable_id != null) addError(errors, 'provider_network', 'A cabled termination cannot be moved to a provider network.');
      if (info.existing && info.existing.circuit_id !== rec.circuit_id) addError(errors, 'circuit', 'Terminations cannot be moved to another circuit.');
      void ctx;
    },
    beforeDelete(row, ctx) {
      if (row.cable_id != null) ctx.remove('dcim.cable', row.cable_id);
    },
    serializeExtra: (r, ctx) => connectionFields(ctx, 'circuits.circuittermination', r),
  },
];
