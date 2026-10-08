/**
 * Generic, model-driven CRUD for DCIM/IPAM objects: input conversion and validation, uniqueness, tags, custom
 * fields, m2m, referential rules on delete, serialization (NetBox shapes), change log and events.
 * Everything is synchronous so a request can run inside one better-sqlite3 transaction.
 */
import { randomUUID } from 'node:crypto';
import type { User } from '../../../shared/src/index.js';
import { now, q, type DB } from '../db/index.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { addError } from './models/common.js';
import { apiUrl, fieldOf, hasCustomFields, isTaggable, modelByType, referencesTo, uiUrl } from './registry.js';
import { choiceLabel, colOf, type Ctx, type Errors, type FieldDef, type ModelDef, type Obj, type Row, type WriteInfo } from './types.js';

const SYSTEM_KEYS = new Set(['id', 'url', 'display', 'display_url', 'created', 'last_updated']);

export function createCtx(db: DB, user: User | null): Ctx {
  const cache = new Map<string, Row | null>();
  const ctx: Ctx = {
    db,
    user,
    requestId: randomUUID(),
    events: [],
    get(type, id) {
      if (id == null) return null;
      const key = `${type}:${id}`;
      if (cache.has(key)) return cache.get(key)!;
      const m = modelByType(type);
      const row = m ? ((db.prepare(`SELECT * FROM ${q(m.table)} WHERE id = ?`).get(id) as Row | undefined) ?? null) : null;
      cache.set(key, row);
      return row;
    },
    ref: (type, id) => nestedRef(ctx, type, id, 1),
    serialize: (type, row) => serialize(ctx, modelByType(type)!, row),
    create: (type, body) => createObject(ctx, modelByType(type)!, body),
    update: (type, id, body) => updateObject(ctx, modelByType(type)!, id, body),
    remove: (type, id) => deleteObject(ctx, modelByType(type)!, id),
    invalidate: () => cache.clear(),
    knownType: (type) => !!modelByType(type),
  };
  return ctx;
}

// ---------------------------------------------------------------------------------------------------------------
// Serialization

const parseJson = (v: unknown) => {
  if (v == null || typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

function fieldValue(ctx: Ctx, f: FieldDef, row: Row, level: number): unknown {
  const v = row[colOf(f)];
  switch (f.kind) {
    case 'fk':
      return level >= 2 ? (v ?? null) : nestedRef(ctx, f.ref!, v, level + 1);
    case 'choice':
      return v == null ? null : { value: v, label: choiceLabel(f, v) };
    case 'bool':
      return v == null ? null : !!v;
    case 'json':
      return parseJson(v);
    default:
      return v ?? null;
  }
}

/** `{id, url, display, ...brief fields}`; level 2 refs leave out their own references. */
export function nestedRef(ctx: Ctx, type: string, id: number | null | undefined, level = 1): Obj | null {
  if (id == null) return null;
  const m = modelByType(type);
  const row = m ? ctx.get(type, id) : null;
  if (!m || !row) return null;
  const o: Obj = { id: row.id, url: apiUrl(m, row.id), display: m.display(row, ctx) };
  for (const name of m.brief) {
    const f = fieldOf(m, name)!;
    if (f.kind === 'fk' && level >= 2) continue;
    o[name] = fieldValue(ctx, f, row, level);
  }
  return o;
}

export function m2mIds(ctx: Ctx, m: ModelDef, f: FieldDef, id: number): number[] {
  return (ctx.db.prepare('SELECT dst_id FROM nb_m2m WHERE field = ? AND src_id = ? ORDER BY dst_id').all(`${m.type}.${f.name}`, id) as { dst_id: number }[]).map(
    (r) => r.dst_id,
  );
}

export function tagIds(ctx: Ctx, type: string, id: number): number[] {
  return (ctx.db.prepare('SELECT tag_id FROM nb_tagged WHERE object_type = ? AND object_id = ? ORDER BY tag_id').all(type, id) as { tag_id: number }[]).map(
    (r) => r.tag_id,
  );
}

export function customFieldDefs(ctx: Ctx, type: string): Row[] {
  const rows = ctx.db.prepare('SELECT * FROM nb_custom_fields ORDER BY weight, name').all() as Row[];
  return rows.filter((r) => (parseJson(r.object_types) as string[] | null)?.includes(type));
}

export function serialize(ctx: Ctx, m: ModelDef, row: Row): Obj {
  const o: Obj = { id: row.id, url: apiUrl(m, row.id), display_url: uiUrl(m, row.id), display: m.display(row, ctx) };
  for (const f of m.fields) {
    o[f.name] = f.kind === 'm2m' ? m2mIds(ctx, m, f, row.id).map((id) => nestedRef(ctx, f.ref!, id)).filter(Boolean) : fieldValue(ctx, f, row, 0);
  }
  Object.assign(o, m.serializeExtra?.(row, ctx));
  if (isTaggable(m)) o.tags = tagIds(ctx, m.type, row.id).map((id) => nestedRef(ctx, 'extras.tag', id)).filter(Boolean);
  if (hasCustomFields(m)) {
    const stored = (parseJson(row.custom_fields) as Record<string, unknown> | null) ?? {};
    const cf: Record<string, unknown> = {};
    for (const d of customFieldDefs(ctx, m.type)) cf[d.name] = stored[d.name] ?? null;
    o.custom_fields = cf;
  }
  o.created = row.created;
  o.last_updated = row.last_updated;
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// Input conversion

type Conv = { value: unknown } | { error: string };

const SLUG_RE = /^[-a-zA-Z0-9_]+$/;
export const slugify = (s: string) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);

/** Resolves a reference given as id, `{id}`, `{slug}`/`{name}`, or a slug/name string. */
export function resolveRef(ctx: Ctx, type: string, raw: unknown): Conv {
  const m = modelByType(type)!;
  let id: number | null = null;
  let lookup: Record<string, unknown> | null = null;
  if (typeof raw === 'number') id = raw;
  else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) id = Number(raw.trim());
  else if (typeof raw === 'string') lookup = { __text: raw.trim() };
  else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (o.id != null) id = Number(o.id);
    else lookup = o;
  } else return { error: 'Invalid reference.' };
  if (id != null) {
    if (!Number.isInteger(id) || !ctx.get(type, id)) return { error: `Related ${m.verbose} ${String(id)} not found.` };
    return { value: id };
  }
  const names = new Set(m.fields.map((f) => f.name));
  const tryCols = (lookup!.__text != null
    ? (['slug', 'name', 'model', 'address', 'prefix'] as const).filter((c) => names.has(c)).map((c) => [c, lookup!.__text] as const)
    : Object.entries(lookup!).filter(([k]) => names.has(k)));
  for (const [col, val] of tryCols) {
    const field = fieldOf(m, col)!;
    if (field.kind === 'fk' || field.kind === 'm2m') continue;
    const rows = ctx.db.prepare(`SELECT id FROM ${q(m.table)} WHERE ${q(col)} = ? LIMIT 2`).all(val) as Row[];
    if (rows.length === 1) return { value: rows[0].id };
    if (rows.length > 1) return { error: `Multiple ${m.verbosePlural} match ${col}="${String(val)}"; use the id.` };
  }
  return { error: `Related ${m.verbose} not found using the provided attributes: ${JSON.stringify(lookup!.__text ?? lookup)}.` };
}

const toBool = (raw: unknown): boolean | null => {
  if (typeof raw === 'boolean') return raw;
  if (raw === 1 || raw === '1' || raw === 'true' || raw === 'True' || raw === 'yes') return true;
  if (raw === 0 || raw === '0' || raw === 'false' || raw === 'False' || raw === 'no') return false;
  return null;
};

export function convert(ctx: Ctx, f: FieldDef, raw: unknown): Conv {
  if (raw === undefined) return { value: undefined };
  if (raw === null || (raw === '' && f.kind !== 'string' && f.kind !== 'text')) return { value: f.kind === 'm2m' ? [] : null };
  switch (f.kind) {
    case 'string':
    case 'text': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'Not a valid string.' };
      const s = String(raw).trim();
      if (f.maxLength && s.length > f.maxLength) return { error: `Ensure this field has no more than ${f.maxLength} characters.` };
      return { value: s === '' && !f.required ? null : s };
    }
    case 'slug': {
      const s = String(raw).trim();
      if (!SLUG_RE.test(s)) return { error: 'Enter a valid "slug" consisting of letters, numbers, underscores or hyphens.' };
      if (f.maxLength && s.length > f.maxLength) return { error: `Ensure this field has no more than ${f.maxLength} characters.` };
      return { value: s };
    }
    case 'int':
    case 'float': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n) || (f.kind === 'int' && !Number.isInteger(n))) return { error: f.kind === 'int' ? 'A valid integer is required.' : 'A valid number is required.' };
      if (f.min != null && n < f.min) return { error: `Ensure this value is greater than or equal to ${f.min}.` };
      if (f.max != null && n > f.max) return { error: `Ensure this value is less than or equal to ${f.max}.` };
      if (f.intChoices && !f.intChoices.includes(n)) return { error: `"${n}" is not a valid choice (${f.intChoices.join(', ')}).` };
      return { value: n };
    }
    case 'bool': {
      const b = toBool(raw);
      return b == null ? { error: 'Must be a valid boolean.' } : { value: b };
    }
    case 'choice': {
      const v = typeof raw === 'object' && raw && 'value' in raw ? (raw as { value: unknown }).value : raw;
      const s = String(v);
      const match = f.choices!.find((c) => c[0] === s) ?? f.choices!.find((c) => c[1].toLowerCase() === s.toLowerCase());
      return match ? { value: match[0] } : { error: `"${s}" is not a valid choice.` };
    }
    case 'color': {
      const s = String(raw).trim().replace(/^#/, '').toLowerCase();
      return /^[0-9a-f]{6}$/.test(s) ? { value: s } : { error: 'Enter a valid hexadecimal RGB color code, e.g. ff0000.' };
    }
    case 'date': {
      const s = String(raw).trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? { value: s } : { error: 'Date has wrong format. Use YYYY-MM-DD.' };
    }
    case 'mac': {
      const hex = String(raw).replace(/[^0-9a-fA-F]/g, '');
      if (hex.length !== 12 || !/^[0-9a-fA-F:.-]+$/.test(String(raw).trim())) return { error: 'Enter a valid MAC address.' };
      return { value: hex.toUpperCase().match(/.{2}/g)!.join(':') };
    }
    case 'cidr':
    case 'ipaddr':
      return typeof raw === 'string' ? { value: raw.trim() } : { error: 'Enter a valid IP prefix/address string.' };
    case 'json':
      return { value: raw };
    case 'fk':
      return resolveRef(ctx, f.ref!, raw);
    case 'm2m': {
      if (!Array.isArray(raw)) return { error: 'Expected a list of items.' };
      const ids: number[] = [];
      for (const item of raw) {
        const r = resolveRef(ctx, f.ref!, item);
        if ('error' in r) return r;
        if (!ids.includes(r.value as number)) ids.push(r.value as number);
      }
      return { value: ids };
    }
  }
}

function parseTags(ctx: Ctx, raw: unknown): Conv {
  if (!Array.isArray(raw)) return { error: 'Expected a list of tags.' };
  const ids: number[] = [];
  for (const item of raw) {
    const r = resolveRef(ctx, 'extras.tag', item);
    if ('error' in r) return r;
    if (!ids.includes(r.value as number)) ids.push(r.value as number);
  }
  return { value: ids };
}

function convertCustomValue(def: Row, v: unknown): Conv {
  if (v === null || v === undefined || v === '') return { value: null };
  const choicesList = (parseJson(def.choices) as string[] | null) ?? [];
  switch (def.type) {
    case 'text':
    case 'longtext': {
      if (typeof v !== 'string') return { error: 'Value must be a string.' };
      if (def.validation_regex && !new RegExp(def.validation_regex).test(v)) return { error: `Value must match regex '${def.validation_regex}'.` };
      return { value: v };
    }
    case 'integer':
    case 'decimal': {
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n) || (def.type === 'integer' && !Number.isInteger(n))) return { error: `Value must be ${def.type === 'integer' ? 'an integer' : 'a number'}.` };
      if (def.validation_minimum != null && n < def.validation_minimum) return { error: `Value must be at least ${def.validation_minimum}.` };
      if (def.validation_maximum != null && n > def.validation_maximum) return { error: `Value must not exceed ${def.validation_maximum}.` };
      return { value: n };
    }
    case 'boolean': {
      const b = toBool(v);
      return b == null ? { error: 'Value must be true or false.' } : { value: b };
    }
    case 'date':
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? { value: v } : { error: 'Date values must be in the format YYYY-MM-DD.' };
    case 'url':
      return typeof v === 'string' && /^(https?|ftp):\/\/\S+$/i.test(v) ? { value: v } : { error: 'Enter a valid URL.' };
    case 'select':
      return choicesList.includes(String(v)) ? { value: String(v) } : { error: `Invalid choice (${String(v)}). Available choices are: ${choicesList.join(', ')}.` };
    case 'multiselect': {
      const arr = Array.isArray(v) ? v.map(String) : String(v).split(',').map((s) => s.trim());
      const bad = arr.filter((x) => !choicesList.includes(x));
      return bad.length ? { error: `Invalid choice(s) (${bad.join(', ')}). Available choices are: ${choicesList.join(', ')}.` } : { value: arr };
    }
    default:
      return { value: v };
  }
}

function mergeCustomFields(ctx: Ctx, m: ModelDef, raw: unknown, existing: Record<string, unknown>, isCreate: boolean, errors: Errors) {
  const defs = customFieldDefs(ctx, m.type);
  const out: Record<string, unknown> = { ...existing };
  const input = raw == null ? {} : raw;
  if (typeof input !== 'object' || Array.isArray(input)) {
    addError(errors, 'custom_fields', 'Expected an object of custom field values.');
    return out;
  }
  const byName = new Map(defs.map((d) => [d.name, d]));
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const def = byName.get(k);
    if (!def) {
      addError(errors, 'custom_fields', `Custom field '${k}' does not exist for this object type.`);
      continue;
    }
    const r = convertCustomValue(def, v);
    if ('error' in r) addError(errors, 'custom_fields', `${k}: ${r.error}`);
    else out[k] = r.value;
  }
  for (const def of defs) {
    if (isCreate && out[def.name] === undefined && def.default != null) out[def.name] = parseJson(def.default);
    if (def.required && (out[def.name] == null || out[def.name] === '')) addError(errors, 'custom_fields', `Required field '${def.name}' must have a value.`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Writes

function toDb(f: FieldDef | undefined, v: unknown) {
  if (v === undefined) return null;
  if (f?.kind === 'bool') return v == null ? null : v ? 1 : 0;
  if (f?.kind === 'json') return v == null ? null : JSON.stringify(v);
  return v as never;
}

/** Existing row → logical record (booleans, parsed JSON). */
function logical(m: ModelDef, row: Row): Row {
  const rec: Row = { ...row };
  for (const f of m.fields) {
    const c = colOf(f);
    if (f.kind === 'bool') rec[c] = row[c] == null ? null : !!row[c];
    if (f.kind === 'json') rec[c] = parseJson(row[c]);
  }
  return rec;
}

function checkUnique(ctx: Ctx, m: ModelDef, rec: Row, errors: Errors) {
  for (const tuple of m.unique ?? []) {
    const fields = tuple.map((n) => fieldOf(m, n)!);
    const last = fields[fields.length - 1];
    if (rec[colOf(last)] == null || errors[last.name]) continue;
    const where: string[] = [];
    const params: unknown[] = [];
    for (const f of fields) {
      const c = q(colOf(f));
      const v = rec[colOf(f)];
      if (v == null) where.push(`${c} IS NULL`);
      else if (typeof v === 'string') {
        where.push(`lower(${c}) = lower(?)`);
        params.push(v);
      } else {
        where.push(`${c} = ?`);
        params.push(v);
      }
    }
    const dup = ctx.db.prepare(`SELECT id FROM ${q(m.table)} WHERE ${where.join(' AND ')} AND id IS NOT ? LIMIT 1`).get(...params, rec.id ?? null);
    if (dup) addError(errors, last.name, `${m.verbose[0].toUpperCase()}${m.verbose.slice(1)} with this ${tuple.join(' and ')} already exists.`);
  }
}

function recordChange(ctx: Ctx, m: ModelDef, action: 'create' | 'update' | 'delete', id: number, repr: string, pre: Obj | null, post: Obj | null) {
  const t = now();
  ctx.db
    .prepare(
      `INSERT INTO nb_changelog (created, last_updated, custom_fields, user_id, user_name, request_id, action, changed_object_type, changed_object_id, object_repr, prechange_data, postchange_data)
       VALUES (?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(t, t, ctx.user?.id ?? null, ctx.user?.name ?? null, ctx.requestId, action, m.type, id, repr, pre ? JSON.stringify(pre) : null, post ? JSON.stringify(post) : null);
  ctx.events.push({ event: action === 'create' ? 'object.created' : action === 'update' ? 'object.updated' : 'object.deleted', objectType: m.type, id, data: (post ?? pre)! });
}

function write(ctx: Ctx, m: ModelDef, body: Record<string, unknown>, existing: Row | null): Row {
  if (m.readOnlyModel) throw badRequest(`${m.verbosePlural} are read-only`);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected a JSON object');
  const errors: Errors = {};
  const info: WriteInfo = { existing, extras: {}, provided: new Set(), m2m: {} };
  const rec: Row = existing ? logical(m, existing) : {};
  let tags: number[] | undefined;
  let cfInput: unknown;

  for (const [key, raw] of Object.entries(body)) {
    if (SYSTEM_KEYS.has(key)) continue;
    if (key === 'tags' && isTaggable(m)) {
      const r = parseTags(ctx, raw);
      if ('error' in r) addError(errors, 'tags', r.error);
      else tags = r.value as number[];
      continue;
    }
    if (key === 'custom_fields' && hasCustomFields(m)) {
      cfInput = raw;
      continue;
    }
    if (m.writeExtras?.includes(key)) {
      info.extras[key] = raw;
      continue;
    }
    const f = fieldOf(m, key);
    if (!f || f.readOnly) continue; // unknown / read-only fields are ignored, as in NetBox
    const r = convert(ctx, f, raw);
    if ('error' in r) {
      addError(errors, key, r.error);
      continue;
    }
    info.provided.add(key);
    if (f.kind === 'm2m') info.m2m[f.name] = r.value as number[];
    else rec[colOf(f)] = r.value;
  }

  if (!existing) {
    for (const f of m.fields) {
      if (info.provided.has(f.name) || f.readOnly) continue;
      if (f.kind === 'm2m') info.m2m[f.name] = [];
      else if (f.default !== undefined) rec[colOf(f)] = f.default;
      else if (f.kind === 'bool') rec[colOf(f)] = false;
      else rec[colOf(f)] = null;
    }
    const slug = fieldOf(m, 'slug');
    if (slug && rec.slug == null && !errors.slug) {
      const source = rec.name ?? rec.model;
      if (source) rec.slug = slugify(source) || null;
    }
  } else {
    for (const f of m.fields) if (f.kind === 'm2m' && !info.provided.has(f.name)) info.m2m[f.name] = m2mIds(ctx, m, f, existing.id);
  }

  m.derive?.(rec, errors, ctx, info);
  for (const f of m.fields) {
    if (!f.required || errors[f.name]) continue;
    const v = rec[colOf(f)];
    if (v == null || v === '') addError(errors, f.name, 'This field is required.');
  }
  if (Object.keys(errors).length === 0) {
    m.validate?.(rec, errors, ctx, info);
    checkUnique(ctx, m, rec, errors);
  }
  let cf: Record<string, unknown> = {};
  if (hasCustomFields(m)) {
    const prev = existing ? ((parseJson(existing.custom_fields) as Record<string, unknown> | null) ?? {}) : {};
    cf = mergeCustomFields(ctx, m, cfInput, prev, !existing, errors);
  }
  if (Object.keys(errors).length) throw badRequest('Validation failed', errors);

  const pre = existing ? serialize(ctx, m, existing) : null;
  const columns = [...m.fields.filter((f) => f.kind !== 'm2m').map(colOf), ...Object.keys(m.extraColumns ?? {})];
  const fieldByCol = new Map(m.fields.map((f) => [colOf(f), f]));
  const t = now();
  let id: number;
  if (!existing) {
    const cols = ['created', 'last_updated', 'custom_fields', ...columns];
    const vals = [t, t, JSON.stringify(cf), ...columns.map((c) => toDb(fieldByCol.get(c), rec[c]))];
    id = Number(ctx.db.prepare(`INSERT INTO ${q(m.table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid);
  } else {
    id = existing.id;
    const sets = ['last_updated = ?', 'custom_fields = ?', ...columns.map((c) => `${q(c)} = ?`)];
    const vals = [t, JSON.stringify(cf), ...columns.map((c) => toDb(fieldByCol.get(c), rec[c]))];
    ctx.db.prepare(`UPDATE ${q(m.table)} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  for (const f of m.fields) {
    if (f.kind !== 'm2m' || (existing && !info.provided.has(f.name) && !(f.name in info.m2m))) continue;
    const key = `${m.type}.${f.name}`;
    ctx.db.prepare('DELETE FROM nb_m2m WHERE field = ? AND src_id = ?').run(key, id);
    const ins = ctx.db.prepare('INSERT OR IGNORE INTO nb_m2m (field, src_id, dst_id) VALUES (?, ?, ?)');
    for (const dst of info.m2m[f.name] ?? []) ins.run(key, id, dst);
  }
  if (tags) {
    ctx.db.prepare('DELETE FROM nb_tagged WHERE object_type = ? AND object_id = ?').run(m.type, id);
    const ins = ctx.db.prepare('INSERT OR IGNORE INTO nb_tagged (object_type, object_id, tag_id) VALUES (?, ?, ?)');
    for (const tag of tags) ins.run(m.type, id, tag);
  }
  ctx.invalidate();
  const row = ctx.get(m.type, id)!;
  m.afterWrite?.(row, ctx, info);
  ctx.invalidate();
  const fresh = ctx.get(m.type, id)!;
  recordChange(ctx, m, existing ? 'update' : 'create', id, m.display(fresh, ctx), pre, serialize(ctx, m, fresh));
  return fresh;
}

export const createObject = (ctx: Ctx, m: ModelDef, body: Record<string, unknown>) => write(ctx, m, body, null);

export function getRowOr404(ctx: Ctx, m: ModelDef, id: number | string): Row {
  const n = Number(id);
  const row = Number.isInteger(n) ? ctx.get(m.type, n) : null;
  if (!row) throw notFound(m.verbose[0].toUpperCase() + m.verbose.slice(1));
  return row;
}

export function updateObject(ctx: Ctx, m: ModelDef, id: number, body: Record<string, unknown>): Row {
  return write(ctx, m, body, getRowOr404(ctx, m, id));
}

export function deleteObject(ctx: Ctx, m: ModelDef, id: number): void {
  if (m.readOnlyModel) throw badRequest(`${m.verbosePlural} are read-only`);
  const row = getRowOr404(ctx, m, id);
  const pre = serialize(ctx, m, row);
  const repr = m.display(row, ctx);
  m.beforeDelete?.(row, ctx);

  const refs = referencesTo(m.type);
  // PROTECT first so nothing is touched when deletion is refused.
  for (const { model, field } of refs) {
    if (field.kind !== 'fk' || (field.onDelete ?? 'protect') !== 'protect' || (model === m && field.name === 'parent')) continue;
    const deps = ctx.db.prepare(`SELECT * FROM ${q(model.table)} WHERE ${q(colOf(field))} = ? LIMIT 5`).all(id) as Row[];
    if (deps.length) {
      throw conflict(
        `Unable to delete ${m.verbose} ${repr}: ${deps.length >= 5 ? '5+' : deps.length} dependent ${model.verbosePlural} (${deps.map((d) => model.display(d, ctx)).join(', ')}) reference it via ${field.name}.`,
      );
    }
  }
  for (const { model, field } of refs) {
    if (field.kind === 'm2m') {
      ctx.db.prepare('DELETE FROM nb_m2m WHERE field = ? AND dst_id = ?').run(`${model.type}.${field.name}`, id);
      continue;
    }
    const rule = field.onDelete ?? 'protect';
    if (rule === 'setnull' || (rule === 'protect' && model === m && field.name === 'parent')) {
      ctx.db.prepare(`UPDATE ${q(model.table)} SET ${q(colOf(field))} = NULL WHERE ${q(colOf(field))} = ?`).run(id);
      ctx.invalidate();
    } else if (rule === 'cascade') {
      const children = ctx.db.prepare(`SELECT id FROM ${q(model.table)} WHERE ${q(colOf(field))} = ?`).all(id) as Row[];
      for (const c of children) if (ctx.get(model.type, c.id)) deleteObject(ctx, model, c.id);
    }
  }
  for (const f of m.fields) if (f.kind === 'm2m') ctx.db.prepare('DELETE FROM nb_m2m WHERE field = ? AND src_id = ?').run(`${m.type}.${f.name}`, id);
  ctx.db.prepare('DELETE FROM nb_tagged WHERE object_type = ? AND object_id = ?').run(m.type, id);
  if (m.type === 'extras.tag') ctx.db.prepare('DELETE FROM nb_tagged WHERE tag_id = ?').run(id);
  ctx.db.prepare(`DELETE FROM ${q(m.table)} WHERE id = ?`).run(id);
  ctx.invalidate();
  recordChange(ctx, m, 'delete', id, repr, pre, null);
}
