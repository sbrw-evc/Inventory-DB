/** NetBox-style list filtering, search, ordering and pagination over a model's table. */
import { q } from '../db/index.js';
import { badRequest } from '../errors.js';
import { customFieldDefs } from './engine.js';
import { fieldOf, isTaggable, modelByType } from './registry.js';
import { colOf, type Ctx, type FieldDef, type ModelDef, type Row, type SqlFrag } from './types.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;
const CONTROL = new Set(['limit', 'offset', 'q', 'ordering', 'brief', 'format']);
const LOOKUPS = new Set(['n', 'ic', 'nic', 'isw', 'iew', 'ie', 'gte', 'lte', 'gt', 'lt', 'empty']);

export type Query = Record<string, string | string[] | undefined>;

const arr = (v: string | string[] | undefined): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const ph = (n: number) => Array(n).fill('?').join(',');
const isText = (f: FieldDef) => ['string', 'text', 'slug', 'choice', 'color', 'date', 'mac', 'cidr', 'ipaddr'].includes(f.kind);

function coerce(f: FieldDef | null, v: string): unknown {
  if (!f) return v;
  if (f.kind === 'bool') return ['true', '1', 'True', 'yes'].includes(v) ? 1 : 0;
  if (f.kind === 'int' || f.kind === 'fk' || f.kind === 'float') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw badRequest(`Invalid value "${v}" for ${f.name}`, { [f.name]: ['Enter a number.'] });
    return n;
  }
  return v;
}

/** Comparison of one SQL expression against filter values with a NetBox lookup suffix. */
function lookupFrag(expr: string, lookup: string, values: string[], f: FieldDef | null): SqlFrag {
  const nullable = values.filter((v) => v === 'null');
  const vals = values.filter((v) => v !== 'null').map((v) => coerce(f, v));
  switch (lookup) {
    case '': {
      const parts: string[] = [];
      if (vals.length) parts.push(`${expr} IN (${ph(vals.length)})`);
      if (nullable.length) parts.push(`${expr} IS NULL`);
      return { sql: `(${parts.join(' OR ')})`, params: vals };
    }
    case 'n': {
      const parts: string[] = [];
      if (vals.length) parts.push(`(${expr} IS NULL OR ${expr} NOT IN (${ph(vals.length)}))`);
      if (nullable.length) parts.push(`${expr} IS NOT NULL`);
      return { sql: `(${parts.join(' AND ')})`, params: vals };
    }
    case 'ic':
    case 'nic':
    case 'isw':
    case 'iew': {
      const pat = (v: unknown) => (lookup === 'isw' ? `${String(v)}%` : lookup === 'iew' ? `%${String(v)}` : `%${String(v)}%`);
      const sql = vals.map(() => `${expr} LIKE ?`).join(' OR ');
      return lookup === 'nic' ? { sql: `NOT (${sql})`, params: vals.map(pat) } : { sql: `(${sql})`, params: vals.map(pat) };
    }
    case 'ie':
      return { sql: `lower(${expr}) IN (${vals.map(() => 'lower(?)').join(',')})`, params: vals };
    case 'gte':
    case 'lte':
    case 'gt':
    case 'lt': {
      const op = { gte: '>=', lte: '<=', gt: '>', lt: '<' }[lookup];
      return { sql: `${expr} ${op} ?`, params: [vals[0]] };
    }
    case 'empty':
      return ['true', '1'].includes(values[0]) ? { sql: `(${expr} IS NULL OR ${expr} = '')`, params: [] } : { sql: `(${expr} IS NOT NULL AND ${expr} != '')`, params: [] };
  }
  throw badRequest(`Unsupported lookup "${lookup}"`);
}

/** Builds WHERE fragments for a query string. Unknown filters are rejected with 400. */
export function buildWhere(ctx: Ctx, m: ModelDef, query: Query): SqlFrag {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (f: SqlFrag) => {
    where.push(f.sql);
    params.push(...f.params);
  };
  const cfDefs = new Map(customFieldDefs(ctx, m.type).map((d) => [d.name, d]));

  for (const [key, raw] of Object.entries(query)) {
    if (CONTROL.has(key)) continue;
    const values = arr(raw).filter((v) => v !== '');
    if (!values.length) continue;
    if (m.filters?.[key]) {
      add(m.filters[key](values, ctx));
      continue;
    }
    const sep = key.lastIndexOf('__');
    const hasLookup = sep > 0 && LOOKUPS.has(key.slice(sep + 2));
    const base = hasLookup ? key.slice(0, sep) : key;
    const lookup = hasLookup ? key.slice(sep + 2) : '';

    if (base === 'id' || base === 'created' || base === 'last_updated') {
      add(lookupFrag(`t.${base}`, lookup, values, base === 'id' ? { name: 'id', kind: 'int' } : null));
      continue;
    }
    if ((base === 'tag' || base === 'tag_id') && isTaggable(m)) {
      const col = base === 'tag' ? 'slug' : 'id';
      const sub = (v: string) => `EXISTS (SELECT 1 FROM nb_tagged x JOIN nb_tags g ON g.id = x.tag_id WHERE x.object_type = '${m.type}' AND x.object_id = t.id AND g.${col} = ?)`;
      // NetBox semantics: repeated tag filters are ANDed
      if (lookup === 'n') add({ sql: values.map((v) => `NOT ${sub(v)}`).join(' AND '), params: values });
      else add({ sql: values.map(sub).join(' AND '), params: values });
      continue;
    }
    if (base.startsWith('cf_') && cfDefs.has(base.slice(3))) {
      const def = cfDefs.get(base.slice(3))!;
      const fake: FieldDef = { name: base, kind: def.type === 'integer' || def.type === 'decimal' ? 'float' : def.type === 'boolean' ? 'bool' : 'string' };
      add(lookupFrag(`json_extract(t.custom_fields, '$.${def.name}')`, lookup, values, fake));
      continue;
    }
    // fk by id (`site_id`) or by slug/name (`site`)
    const fkById = base.endsWith('_id') ? fieldOf(m, base.slice(0, -3)) : undefined;
    if (fkById?.kind === 'fk') {
      add(lookupFrag(`t.${q(colOf(fkById))}`, lookup, values, fkById));
      continue;
    }
    const f = fieldOf(m, base);
    if (f?.kind === 'fk') {
      const rel = modelByType(f.ref!)!;
      const col = fieldOf(rel, 'slug') ? 'slug' : fieldOf(rel, 'name') ? 'name' : fieldOf(rel, 'model') ? 'model' : 'id';
      const neg = lookup === 'n';
      const vals = values.filter((v) => v !== 'null');
      const parts: string[] = [];
      if (vals.length) parts.push(`t.${q(colOf(f))} ${neg ? 'NOT ' : ''}IN (SELECT id FROM ${q(rel.table)} WHERE ${q(col)} IN (${ph(vals.length)}))`);
      if (values.includes('null')) parts.push(`t.${q(colOf(f))} IS ${neg ? 'NOT ' : ''}NULL`);
      add({ sql: `(${parts.join(neg ? ' AND ' : ' OR ')})`, params: vals });
      continue;
    }
    if (f && f.kind !== 'm2m' && f.kind !== 'json') {
      if (!isText(f) && ['ic', 'nic', 'isw', 'iew', 'ie'].includes(lookup)) throw badRequest(`Lookup "${lookup}" is not supported for ${base}`);
      add(lookupFrag(`t.${q(colOf(f))}`, lookup, values, f));
      continue;
    }
    throw badRequest(`Unknown filter "${key}"`, { [key]: ['Unknown filter.'] });
  }

  const qText = arr(query.q)[0]?.trim();
  if (qText) {
    const cols = m.fields.filter((f) => f.search).map((f) => `t.${q(colOf(f))} LIKE ?`);
    const parts = [...cols];
    const ps: unknown[] = cols.map(() => `%${qText}%`);
    const extra = m.searchExtra?.(qText);
    if (extra) {
      parts.push(extra.sql);
      ps.push(...extra.params);
    }
    if (/^\d+$/.test(qText)) {
      parts.push('t.id = ?');
      ps.push(Number(qText));
    }
    if (parts.length) add({ sql: `(${parts.join(' OR ')})`, params: ps });
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function buildOrder(m: ModelDef, ordering: string | undefined): string {
  const keys = (ordering ? ordering.split(',') : m.ordering).map((k) => k.trim()).filter(Boolean);
  const parts: string[] = [];
  for (const k of keys) {
    const desc = k.startsWith('-');
    const name = desc ? k.slice(1) : k;
    const dir = desc ? ' DESC' : '';
    if (m.orderExpr?.[name]) {
      parts.push(...m.orderExpr[name].split(',').map((e) => `${e.trim()}${dir}`));
      continue;
    }
    if (name === 'id' || name === 'created' || name === 'last_updated') {
      parts.push(`t.${name}${dir}`);
      continue;
    }
    const f = fieldOf(m, name);
    if (!f || f.kind === 'm2m' || f.kind === 'json') throw badRequest(`Cannot order by "${name}"`, { ordering: [`Unknown field "${name}".`] });
    if (f.kind === 'fk') {
      const rel = modelByType(f.ref!)!;
      const relOrder = rel.orderExpr?.[rel.ordering[0]?.replace(/^-/, '')];
      const relCol = relOrder ? null : fieldOf(rel, 'name') ? 'name' : fieldOf(rel, 'model') ? 'model' : null;
      if (relCol) parts.push(`(SELECT ${q(relCol)} FROM ${q(rel.table)} r WHERE r.id = t.${q(colOf(f))}) COLLATE NOCASE${dir}`);
      else parts.push(`t.${q(colOf(f))}${dir}`);
      continue;
    }
    parts.push(`t.${q(colOf(f))}${isText(f) ? ' COLLATE NOCASE' : ''}${dir}`);
  }
  parts.push('t.id');
  return `ORDER BY ${parts.join(', ')}`;
}

export function pageParams(query: Query) {
  const rawLimit = arr(query.limit)[0];
  const rawOffset = arr(query.offset)[0];
  let limit = rawLimit == null ? DEFAULT_LIMIT : Number(rawLimit);
  const offset = rawOffset == null ? 0 : Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 0) throw badRequest('Invalid limit');
  if (!Number.isInteger(offset) || offset < 0) throw badRequest('Invalid offset');
  if (limit === 0 || limit > MAX_LIMIT) limit = MAX_LIMIT;
  return { limit, offset };
}

export function listRows(ctx: Ctx, m: ModelDef, query: Query): { count: number; rows: Row[]; limit: number; offset: number } {
  const { limit, offset } = pageParams(query);
  const where = buildWhere(ctx, m, query);
  const order = buildOrder(m, arr(query.ordering)[0]);
  const total = (ctx.db.prepare(`SELECT COUNT(*) n FROM ${q(m.table)} t ${where.sql}`).get(...where.params) as { n: number }).n;
  const rows = ctx.db.prepare(`SELECT t.* FROM ${q(m.table)} t ${where.sql} ${order} LIMIT ? OFFSET ?`).all(...where.params, limit, offset) as Row[];
  return { count: total, rows, limit, offset };
}

/** `next` / `previous` links built from the request URL. */
export function pageLinks(url: string, count: number, limit: number, offset: number) {
  const u = new URL(url, 'http://local');
  const link = (o: number) => {
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('offset', String(o));
    return `${u.pathname}?${u.searchParams.toString()}`;
  };
  return {
    next: offset + limit < count ? link(offset + limit) : null,
    previous: offset > 0 ? link(Math.max(0, offset - limit)) : null,
  };
}
