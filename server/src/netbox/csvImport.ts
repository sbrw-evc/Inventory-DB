/**
 * CSV bulk import: header = field names, references by id, slug or name. Extra columns:
 * `tags` (comma separated slugs), `cf_<name>` (custom fields), and per type:
 * - devices: `rack` / `location` are resolved within the row's site
 * - interfaces: `lag` / `parent` are resolved within the row's device
 * - ip-addresses: `device` + `interface` assign the address to that interface
 * - cables: `side_a_device`, `side_a_name`, `side_b_device`, `side_b_name`
 * All rows are created in one transaction; any row error rejects the whole file.
 */
import Papa from 'papaparse';
import { badRequest, HttpError } from '../errors.js';
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
    case 'ipam.ipaddress': {
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
        const dev = body[`side_${side}_device`] as string | undefined;
        const name = body[`side_${side}_name`] as string | undefined;
        delete body[`side_${side}_device`];
        delete body[`side_${side}_name`];
        delete body[`side_${side}_type`];
        if (!dev || !name) throw badRequest('Validation failed', { [`side_${side}_name`]: ['Device and interface name are required.'] });
        const deviceId = refId(ctx, 'dcim.device', dev, `side_${side}_device`);
        body[`${side}_terminations`] = [{ object_type: 'dcim.interface', object_id: scoped(ctx, 'nb_interfaces', name, 'device_id', deviceId, `side_${side}_name`) }];
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
