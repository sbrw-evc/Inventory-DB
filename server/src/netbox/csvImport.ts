/**
 * CSV bulk import: header = field names, references by id, slug or name. Extra columns:
 * `tags` (comma separated slugs), `cf_<name>` (custom fields), and per type:
 * - devices: `rack` / `location` are resolved within the row's site
 * - interfaces: `lag` / `parent` are resolved within the row's device
 * - ip-addresses: `device` + `interface` assign the address to that interface
 * - front ports: `rear_port` within the row's device; power outlets: `power_port` within the device
 * - VM interfaces: `parent` / `bridge` within the row's virtual machine
 * - ip-addresses: `virtual_machine` + `vminterface` assign the address to that VM interface
 * - power feeds: `power_panel` within `site` when given; `rack` within the panel's site
 * - cables: `side_a_type` (default dcim.interface), `side_a_device`, `side_a_name`, and the same for side B;
 *   circuit terminations use `side_a_circuit` (cid) + `side_a_name` (A/Z); power feeds `side_a_power_panel` + name
 * All rows are created in one transaction; any row error rejects the whole file.
 */
import Papa from 'papaparse';
import { badRequest, HttpError } from '../errors.js';
import { TERMINATION_TYPES } from './cabling.js';
import { createObject, resolveRef } from './engine.js';
import { fieldOf } from './registry.js';
import type { Ctx, ModelDef, Obj, Row } from './types.js';

const isId = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);

function scoped(ctx: Ctx, table: string, value: string, scopeCol: string, scopeId: number, what: string): number {
  if (isId(value)) return Number(value);
  const rows = ctx.db.prepare(`SELECT id FROM ${table} WHERE name = ? AND ${scopeCol} = ?`).all(value, scopeId) as Row[];
  if (rows.length !== 1) throw badRequest('Validation failed', { [what]: [`${what} "${value}" not found${rows.length > 1 ? ' (ambiguous)' : ''}.`] });
  return rows[0].id;
}

function refId(ctx: Ctx, type: string, value: string, field: string): number {
  const r = resolveRef(ctx, type, value);
  if ('error' in r) throw badRequest('Validation failed', { [field]: [r.error] });
  return r.value as number;
}

function rowToBody(ctx: Ctx, m: ModelDef, raw: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v0] of Object.entries(raw)) {
    const v = (v0 ?? '').trim();
    if (!k || v === '') continue;
    if (k === 'tags') body.tags = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (k.startsWith('cf_')) ((body.custom_fields ??= {}) as Record<string, unknown>)[k.slice(3)] = v;
    else if (fieldOf(m, k)?.kind === 'm2m') body[k] = v.split(',').map((s) => s.trim()).filter(Boolean);
    else body[k] = v;
  }
  switch (m.type) {
    case 'dcim.device': {
      if (body.site && !isId(body.site)) body.site = refId(ctx, 'dcim.site', body.site as string, 'site');
      if (body.site != null) {
        const siteId = Number(body.site);
        if (body.location) body.location = scoped(ctx, 'nb_locations', body.location as string, 'site_id', siteId, 'location');
        if (body.rack) body.rack = scoped(ctx, 'nb_racks', body.rack as string, 'site_id', siteId, 'rack');
      }
      break;
    }
    case 'dcim.rack': {
      if (body.site && !isId(body.site)) body.site = refId(ctx, 'dcim.site', body.site as string, 'site');
      if (body.location && body.site != null) body.location = scoped(ctx, 'nb_locations', body.location as string, 'site_id', Number(body.site), 'location');
      break;
    }
    case 'dcim.interface': {
      if (body.device && !isId(body.device)) body.device = refId(ctx, 'dcim.device', body.device as string, 'device');
      for (const f of ['lag', 'parent']) {
        if (body[f] && body.device != null) body[f] = scoped(ctx, 'nb_interfaces', body[f] as string, 'device_id', Number(body.device), f);
      }
      break;
    }
    case 'dcim.frontport':
    case 'dcim.poweroutlet': {
      if (body.device && !isId(body.device)) body.device = refId(ctx, 'dcim.device', body.device as string, 'device');
      const [f, table] = m.type === 'dcim.frontport' ? ['rear_port', 'nb_rear_ports'] : ['power_port', 'nb_power_ports'];
      if (body[f] && body.device != null) body[f] = scoped(ctx, table, body[f] as string, 'device_id', Number(body.device), f);
      break;
    }
    case 'virtualization.vminterface': {
      if (body.virtual_machine && !isId(body.virtual_machine)) body.virtual_machine = refId(ctx, 'virtualization.virtualmachine', body.virtual_machine as string, 'virtual_machine');
      for (const f of ['parent', 'bridge']) {
        if (body[f] && body.virtual_machine != null) body[f] = scoped(ctx, 'nb_vm_interfaces', body[f] as string, 'virtual_machine_id', Number(body.virtual_machine), f);
      }
      break;
    }
    case 'dcim.powerfeed': {
      if (body.site) {
        const siteId = refId(ctx, 'dcim.site', body.site as string, 'site');
        if (body.power_panel) body.power_panel = scoped(ctx, 'nb_power_panels', body.power_panel as string, 'site_id', siteId, 'power_panel');
        delete body.site;
      }
      if (body.power_panel && !isId(body.power_panel)) body.power_panel = refId(ctx, 'dcim.powerpanel', body.power_panel as string, 'power_panel');
      const panel = body.power_panel != null ? ctx.get('dcim.powerpanel', Number(body.power_panel)) : null;
      if (body.rack && panel) body.rack = scoped(ctx, 'nb_racks', body.rack as string, 'site_id', panel.site_id, 'rack');
      break;
    }
    case 'ipam.ipaddress': {
      if (body.vminterface) {
        if (!body.virtual_machine) throw badRequest('Validation failed', { virtual_machine: ['A virtual machine is required to resolve the interface.'] });
        const vmId = refId(ctx, 'virtualization.virtualmachine', body.virtual_machine as string, 'virtual_machine');
        body.assigned_object_type = 'virtualization.vminterface';
        body.assigned_object_id = scoped(ctx, 'nb_vm_interfaces', body.vminterface as string, 'virtual_machine_id', vmId, 'vminterface');
      }
      delete body.virtual_machine;
      delete body.vminterface;
      if (body.interface) {
        if (!body.device) throw badRequest('Validation failed', { device: ['A device is required to resolve the interface.'] });
        const deviceId = refId(ctx, 'dcim.device', body.device as string, 'device');
        body.assigned_object_type = 'dcim.interface';
        body.assigned_object_id = scoped(ctx, 'nb_interfaces', body.interface as string, 'device_id', deviceId, 'interface');
      }
      delete body.device;
      delete body.interface;
      break;
    }
    case 'dcim.cable': {
      for (const side of ['a', 'b']) {
        const k = (f: string) => `side_${side}_${f}`;
        const take = (f: string) => {
          const v = body[k(f)] as string | undefined;
          delete body[k(f)];
          return v;
        };
        const type = take('type') || 'dcim.interface';
        const dev = take('device');
        const circuit = take('circuit');
        const panel = take('power_panel');
        const name = take('name');
        const t = TERMINATION_TYPES[type];
        if (!t) throw badRequest('Validation failed', { [k('type')]: [`Unsupported termination type "${type}".`] });
        if (!name) throw badRequest('Validation failed', { [k('name')]: ['A termination name is required.'] });
        let id: number;
        if (type === 'circuits.circuittermination') {
          if (!circuit) throw badRequest('Validation failed', { [k('circuit')]: ['The circuit ID is required.'] });
          const circuitId = refId(ctx, 'circuits.circuit', circuit, k('circuit'));
          const row = ctx.db.prepare('SELECT id FROM nb_circuit_terminations WHERE circuit_id = ? AND term_side = ?').get(circuitId, name.toUpperCase()) as Row | undefined;
          if (!row) throw badRequest('Validation failed', { [k('name')]: [`Termination ${name} of circuit ${circuit} not found.`] });
          id = row.id;
        } else if (type === 'dcim.powerfeed') {
          id = panel ? scoped(ctx, 'nb_power_feeds', name, 'power_panel_id', refId(ctx, 'dcim.powerpanel', panel, k('power_panel')), k('name')) : refId(ctx, 'dcim.powerfeed', name, k('name'));
        } else {
          if (!dev) throw badRequest('Validation failed', { [k('device')]: ['Device is required.'] });
          id = scoped(ctx, t.table, name, 'device_id', refId(ctx, 'dcim.device', dev, k('device')), k('name'));
        }
        body[`${side}_terminations`] = [{ object_type: type, object_id: id }];
      }
      break;
    }
  }
  return body;
}

export function importCsv(ctx: Ctx, m: ModelDef, text: string): Obj[] {
  if (m.readOnlyModel) throw badRequest(`${m.verbosePlural} cannot be imported`);
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, '').trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length) {
    throw badRequest('Invalid CSV', parsed.errors.slice(0, 10).map((e) => ({ row: (e.row ?? 0) + 1, message: e.message })));
  }
  if (!parsed.data.length) throw badRequest('The CSV has no data rows');
  const created: Obj[] = [];
  const errors: { row: number; errors: unknown }[] = [];
  parsed.data.forEach((raw, i) => {
    try {
      const row = createObject(ctx, m, rowToBody(ctx, m, raw));
      created.push(ctx.serialize(m.type, row));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      errors.push({ row: i + 1, errors: e.details ?? { __all__: [e.message] } });
    }
  });
  if (errors.length) throw badRequest(`Import failed: ${errors.length} row(s) have errors`, errors);
  return created;
}
