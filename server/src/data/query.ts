/**
 * Query compiler: column expressions (incl. virtual Links/Lookup/Rollup/Formula), filters, sorts and search.
 * Values are always bound as parameters; identifiers only come from metadata.
 */
import type { FilterCondition, FilterGroup, FilterOp, Sort } from '../../../shared/src/index.js';
import { FILTER_OPS, isFilterGroup } from '../../../shared/src/index.js';
import { dataColumnName, dataTableName, q } from '../db/index.js';
import { badRequest } from '../errors.js';
import { type ColumnMeta, findColumn, linkInfo, loadColumns } from '../meta/store.js';
import { DATE_TYPES, JSON_TYPES, NUMERIC_TYPES, TEXT_TYPES } from './codec.js';
import { FormulaError, compileFormula, parseFormula } from './formula.js';
import { type Frag, join, likeEscape, raw, sql, val } from './sql.js';

/** Per-request metadata cache + alias generator. */
export class QueryContext {
  private byTable = new Map<string, ColumnMeta[]>();
  private byId = new Map<string, ColumnMeta>();
  private n = 0;
  /** strict: errors in virtual columns throw (used when validating on save) instead of yielding NULL */
  constructor(public strict = false) {}

  columns(tableId: string): ColumnMeta[] {
    let cols = this.byTable.get(tableId);
    if (!cols) {
      cols = loadColumns(tableId);
      this.byTable.set(tableId, cols);
      for (const c of cols) this.byId.set(c.id, c);
    }
    return cols;
  }

  column(id: string | undefined): ColumnMeta | undefined {
    if (!id) return undefined;
    let c = this.byId.get(id);
    if (!c) {
      const found = findColumn(id);
      if (found) {
        this.columns(found.tableId);
        c = this.byId.get(id);
      }
    }
    return c;
  }

  /** Override (or add) a column definition, e.g. to validate a column before it is saved. */
  put(col: ColumnMeta) {
    const cols = this.columns(col.tableId).filter((c) => c.id !== col.id);
    cols.push(col);
    this.byTable.set(col.tableId, cols);
    this.byId.set(col.id, col);
  }

  alias(prefix = 'x'): string {
    return `${prefix}${++this.n}`;
  }
}

const isJsonish = (c: ColumnMeta) => JSON_TYPES.includes(c.type);

/**
 * SQL expression for a column of the row aliased `alias`. `stack` tracks virtual columns being expanded,
 * to detect circular references.
 */
export function colExpr(ctx: QueryContext, col: ColumnMeta, alias: string, stack: string[] = []): Frag {
  const a = q(alias);
  switch (col.type) {
    case 'ID':
      return raw(`${a}.id`);
    case 'CreatedTime':
      return raw(`${a}.created_at`);
    case 'LastModifiedTime':
      return raw(`${a}.updated_at`);
    case 'Links':
    case 'Lookup':
    case 'Rollup':
    case 'Formula':
      if (stack.includes(col.id)) {
        const names = [...stack.slice(stack.indexOf(col.id)), col.id].map((id) => ctx.column(id)?.title ?? id);
        throw new FormulaError(`Circular reference: ${names.join(' → ')}`);
      }
      try {
        return virtualExpr(ctx, col, alias, [...stack, col.id]);
      } catch (e) {
        if (ctx.strict || stack.length > 0) throw e;
        return raw('NULL');
      }
    default:
      return raw(`${a}.${q(dataColumnName(col.id))}`);
  }
}

function linkParts(ctx: QueryContext, col: ColumnMeta) {
  if (col.type !== 'Links') throw new FormulaError(`Field "${col.title}" is not a Links field`);
  const li = linkInfo(col);
  return { ...li, j: ctx.alias('j'), r: ctx.alias('r') };
}

function virtualExpr(ctx: QueryContext, col: ColumnMeta, alias: string, stack: string[]): Frag {
  const a = q(alias);
  switch (col.type) {
    case 'Links': {
      const { junction, self } = linkInfo(col);
      const j = q(ctx.alias('j'));
      return raw(`(SELECT COUNT(*) FROM ${q(junction)} ${j} WHERE ${j}.${self} = ${a}.id)`);
    }
    case 'Lookup':
    case 'Rollup': {
      const link = ctx.column(col.options.linkColumnId);
      if (!link || link.tableId !== col.tableId) throw new FormulaError(`${col.type} "${col.title}" has no valid Links field`);
      const p = linkParts(ctx, link);
      const from = raw(
        `FROM ${q(p.junction)} ${q(p.j)} JOIN ${q(dataTableName(p.relatedTableId))} ${q(p.r)} ON ${q(p.r)}.id = ${q(p.j)}.${p.other} WHERE ${q(p.j)}.${p.self} = ${a}.id`,
      );
      const fn = col.type === 'Rollup' ? (col.options.rollupFunction ?? 'count') : null;
      if (fn === 'count') return sql`(SELECT COUNT(${raw(q(p.r))}.id) ${from})`;
      const target = ctx.column(col.options.targetColumnId);
      if (!target || target.tableId !== p.relatedTableId) throw new FormulaError(`${col.type} "${col.title}" has no valid target field`);
      const inner = colExpr(ctx, target, p.r, stack);
      if (col.type === 'Lookup') {
        const v = isJsonish(target) ? sql`json(${inner})` : inner;
        return sql`(SELECT json_group_array(${v} ORDER BY ${raw(q(p.j))}.rowid) ${from})`;
      }
      switch (fn) {
        case 'sum':
          return sql`(SELECT COALESCE(SUM(${inner}), 0) ${from})`;
        case 'sumDistinct':
          return sql`(SELECT COALESCE(SUM(DISTINCT ${inner}), 0) ${from})`;
        case 'countDistinct':
          return sql`(SELECT COUNT(DISTINCT ${inner}) ${from})`;
        case 'avg':
          return sql`(SELECT AVG(${inner}) ${from})`;
        case 'min':
          return sql`(SELECT MIN(${inner}) ${from})`;
        case 'max':
          return sql`(SELECT MAX(${inner}) ${from})`;
        default:
          throw new FormulaError(`Unknown rollup function ${fn}`);
      }
    }
    case 'Formula': {
      if (!col.options.formula) return raw('NULL');
      const node = parseFormula(col.options.formula);
      const cols = ctx.columns(col.tableId);
      return compileFormula(node, (ref) => {
        const target = cols.find((c) => c.id === ref);
        if (!target) throw new FormulaError(`Formula "${col.title}" references a deleted field`);
        return colExpr(ctx, target, alias, stack);
      });
    }
    default:
      throw new Error('not virtual');
  }
}

/** Links shown on a single record: JSON array of {id, display} (max 25). */
export function linksDetailExpr(ctx: QueryContext, col: ColumnMeta, alias: string): Frag {
  const p = linkParts(ctx, col);
  const primary = ctx.columns(p.relatedTableId).find((c) => c.primary) ?? ctx.columns(p.relatedTableId)[0];
  let display = primary ? colExpr(ctx, primary, p.r) : raw('NULL');
  if (primary && isJsonish(primary)) display = sql`CAST(${display} AS TEXT)`;
  return sql`(SELECT json_group_array(json_object('id', x.id, 'display', x.d)) FROM (SELECT ${raw(q(p.r))}.id AS id, ${display} AS d FROM ${raw(
    q(p.junction),
  )} ${raw(q(p.j))} JOIN ${raw(q(dataTableName(p.relatedTableId)))} ${raw(q(p.r))} ON ${raw(q(p.r))}.id = ${raw(q(p.j))}.${raw(p.other)} WHERE ${raw(
    q(p.j),
  )}.${raw(p.self)} = ${raw(q(alias))}.id ORDER BY ${raw(q(p.j))}.rowid LIMIT 25) x)`;
}

// ---------------------------------------------------------------------------------------------------------------
// Filters

const WITHIN: Record<string, [string, string]> = {
  pastWeek: ['-7 days', '+0 days'],
  pastMonth: ['-1 month', '+0 days'],
  pastYear: ['-1 year', '+0 days'],
  nextWeek: ['+0 days', '+7 days'],
  nextMonth: ['+0 days', '+1 month'],
  nextYear: ['+0 days', '+1 year'],
  pastNumberOfDays: ['', ''],
  nextNumberOfDays: ['', ''],
};

const isEmptyValue = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

function listValue(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string')
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return v == null ? [] : [String(v)];
}

function numValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

/** Normalises a date filter value; supports 'today' | 'tomorrow' | 'yesterday' and ISO strings. */
function dateValue(v: unknown): { frag: Frag; dateOnly: boolean } | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  const rel: Record<string, string> = { today: '+0 days', tomorrow: '+1 day', yesterday: '-1 day' };
  if (rel[s]) return { frag: raw(`date('now', '${rel[s]}')`), dateOnly: true };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { frag: val(s), dateOnly: true };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return { frag: val(d.toISOString()), dateOnly: false };
}

const BLANK = (e: Frag) => sql`(${e} IS NULL OR ${e} = '' OR ${e} = '[]')`;
const CMP: Partial<Record<FilterOp, string>> = { eq: '=', neq: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=' };

/**
 * Compiles one condition. Returns null when the condition should be ignored (e.g. empty value, as NocoDB does).
 * Throws 400 for unknown columns/ops in strict mode.
 */
function compileCondition(ctx: QueryContext, cond: FilterCondition, tableId: string, alias: string, strict: boolean): Frag | null {
  const col = ctx.column(cond.columnId);
  if (!col || col.tableId !== tableId) {
    if (strict) throw badRequest(`Filter references unknown field ${cond.columnId}`);
    return null;
  }
  if (!FILTER_OPS.includes(cond.op)) {
    if (strict) throw badRequest(`Unknown filter operator ${cond.op}`);
    return null;
  }
  const e = colExpr(ctx, col, alias);
  const op = cond.op;
  const v = cond.value;
  const t = col.type;

  if (op === 'blank' || op === 'notblank') {
    let blank: Frag;
    if (t === 'Links') blank = sql`${e} = 0`;
    else if (t === 'Lookup') blank = sql`NOT EXISTS (SELECT 1 FROM json_each(${e}) WHERE value IS NOT NULL AND value != '')`;
    else if (t === 'Checkbox') blank = sql`COALESCE(${e}, 0) = 0`;
    else blank = BLANK(e);
    return op === 'blank' ? blank : sql`NOT ${blank}`;
  }
  if (op === 'checked') return sql`COALESCE(${e}, 0) != 0`;
  if (op === 'notchecked') return sql`COALESCE(${e}, 0) = 0`;

  if (t === 'Checkbox' && (op === 'eq' || op === 'neq')) {
    if (isEmptyValue(v)) return null;
    const want = v === true || v === 1 || v === 'true' || v === '1';
    const checked = sql`COALESCE(${e}, 0) != 0`;
    return want === (op === 'eq') ? checked : sql`NOT ${checked}`;
  }

  if (isEmptyValue(v)) return null;

  // "Any element matches" semantics for multi-valued fields.
  if (t === 'Lookup' || t === 'MultiSelect') {
    const each = (pred: (x: Frag) => Frag) => sql`EXISTS (SELECT 1 FROM json_each(${e}) WHERE ${pred(raw('value'))})`;
    const opts = listValue(v);
    switch (op) {
      case 'anyof':
      case 'nanyof': {
        const any = each((x) => sql`lower(${x}) IN (${join(
          opts.map((o) => sql`lower(${val(o)})`),
          ', ',
        )})`);
        return op === 'anyof' ? any : sql`NOT ${any}`;
      }
      case 'allof':
      case 'nallof': {
        const all = join(
          opts.map((o) => each((x) => sql`lower(${x}) = lower(${val(o)})`)),
          ' AND ',
        );
        return op === 'allof' ? sql`(${all})` : sql`NOT (${all})`;
      }
      case 'eq':
      case 'neq': {
        if (t === 'MultiSelect') {
          const all = join(
            opts.map((o) => each((x) => sql`lower(${x}) = lower(${val(o)})`)),
            ' AND ',
          );
          const exact = sql`(${all} AND json_array_length(${e}) = ${val(opts.length)})`;
          return op === 'eq' ? exact : sql`NOT COALESCE(${exact}, 0)`;
        }
        const n = numValue(v);
        const m = each((x) => (n != null ? sql`(${x} = ${val(n)} OR lower(CAST(${x} AS TEXT)) = lower(${val(String(v))}))` : sql`lower(CAST(${x} AS TEXT)) = lower(${val(String(v))})`));
        return op === 'eq' ? m : sql`NOT ${m}`;
      }
      case 'like':
      case 'nlike': {
        const m = each((x) => sql`CAST(${x} AS TEXT) LIKE ${val(`%${likeEscape(String(v))}%`)} ESCAPE '\\'`);
        return op === 'like' ? m : sql`NOT ${m}`;
      }
      case 'gt':
      case 'lt':
      case 'gte':
      case 'lte': {
        const n = numValue(v);
        if (n != null) return each((x) => sql`${x} ${raw(CMP[op]!)} ${val(n)}`);
        return each((x) => sql`${x} ${raw(CMP[op]!)} ${val(String(v))}`);
      }
      default:
        if (strict) throw badRequest(`Operator ${op} is not supported for ${t} fields`);
        return null;
    }
  }

  if (DATE_TYPES.includes(t)) {
    if (op === 'isWithin') {
      const key = String(v);
      const range = WITHIN[key];
      if (!range) {
        if (strict) throw badRequest(`Unknown isWithin value ${key}`);
        return null;
      }
      if (key === 'pastNumberOfDays' || key === 'nextNumberOfDays') return null;
      return sql`(date(${e}) BETWEEN date('now', ${raw(`'${range[0]}'`)}) AND date('now', ${raw(`'${range[1]}'`)}))`;
    }
    const cmp = CMP[op];
    if (!cmp) {
      if (strict) throw badRequest(`Operator ${op} is not supported for ${t} fields`);
      return null;
    }
    const d = dateValue(v);
    if (!d) {
      if (strict) throw badRequest(`Invalid date "${String(v)}" in filter`);
      return null;
    }
    const lhs = d.dateOnly || t === 'Date' ? sql`date(${e})` : sql`julianday(${e})`;
    const rhs = d.dateOnly || t === 'Date' ? sql`date(${d.frag})` : sql`julianday(${d.frag})`;
    const c = sql`${lhs} ${raw(cmp)} ${rhs}`;
    return op === 'neq' ? sql`(${e} IS NULL OR ${c})` : c;
  }

  if (NUMERIC_TYPES.includes(t) || t === 'Links') {
    const cmp = CMP[op];
    if (op === 'anyof' || op === 'nanyof') {
      const nums = listValue(v).map(Number).filter(Number.isFinite);
      const inList = sql`${e} IN (${join(nums.map(val), ', ')})`;
      return op === 'anyof' ? inList : sql`(${e} IS NULL OR NOT ${inList})`;
    }
    if (!cmp) {
      if (op === 'like' || op === 'nlike') {
        const m = sql`CAST(${e} AS TEXT) LIKE ${val(`%${likeEscape(String(v))}%`)} ESCAPE '\\'`;
        return op === 'like' ? m : sql`(${e} IS NULL OR NOT ${m})`;
      }
      if (strict) throw badRequest(`Operator ${op} is not supported for ${t} fields`);
      return null;
    }
    const n = numValue(v);
    if (n == null) {
      if (strict) throw badRequest(`Filter on "${col.title}" needs a number`);
      return null;
    }
    const c = sql`${e} ${raw(cmp)} ${val(n)}`;
    return op === 'neq' ? sql`(${e} IS NULL OR ${c})` : c;
  }

  // Text-like, SingleSelect, Formula, JSON, Attachment
  switch (op) {
    case 'eq':
    case 'neq': {
      const n = t === 'Formula' ? numValue(v) : null;
      const c =
        n != null
          ? sql`(${e} = ${val(n)} OR lower(CAST(${e} AS TEXT)) = lower(${val(String(v))}))`
          : sql`lower(CAST(${e} AS TEXT)) = lower(${val(typeof v === 'boolean' ? (v ? 1 : 0) : String(v))})`;
      return op === 'eq' ? c : sql`(${e} IS NULL OR NOT ${c})`;
    }
    case 'like':
    case 'nlike': {
      const m = sql`CAST(${e} AS TEXT) LIKE ${val(`%${likeEscape(String(v))}%`)} ESCAPE '\\'`;
      return op === 'like' ? m : sql`(${e} IS NULL OR NOT ${m})`;
    }
    case 'anyof':
    case 'nanyof': {
      const opts = listValue(v);
      const inList = sql`lower(${e}) IN (${join(
        opts.map((o) => sql`lower(${val(o)})`),
        ', ',
      )})`;
      return op === 'anyof' ? inList : sql`(${e} IS NULL OR NOT ${inList})`;
    }
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      const n = numValue(v);
      return sql`${e} ${raw(CMP[op]!)} ${val(n ?? String(v))}`;
    }
    default:
      if (strict) throw badRequest(`Operator ${op} is not supported for ${t} fields`);
      return null;
  }
}

export function compileFilter(ctx: QueryContext, group: FilterGroup | null | undefined, tableId: string, alias: string, strict: boolean): Frag | null {
  if (!group) return null;
  if (!Array.isArray(group.children)) {
    if (strict) throw badRequest('Filter group needs a children array');
    return null;
  }
  const parts: Frag[] = [];
  for (const child of group.children) {
    const f = isFilterGroup(child) ? compileFilter(ctx, child, tableId, alias, strict) : compileCondition(ctx, child, tableId, alias, strict);
    if (f) parts.push(sql`(${f})`);
  }
  if (!parts.length) return null;
  return join(parts, group.logic === 'or' ? ' OR ' : ' AND ');
}

export function compileSorts(ctx: QueryContext, sorts: Sort[], tableId: string, alias: string, strict: boolean): Frag {
  const parts: Frag[] = [];
  for (const s of sorts) {
    const col = ctx.column(s.columnId);
    if (!col || col.tableId !== tableId) {
      if (strict) throw badRequest(`Sort references unknown field ${s.columnId}`);
      continue;
    }
    let e = colExpr(ctx, col, alias);
    if (TEXT_TYPES.includes(col.type) || col.type === 'SingleSelect') e = sql`${e} COLLATE NOCASE`;
    parts.push(sql`${e} ${raw(s.direction === 'desc' ? 'DESC' : 'ASC')}`);
  }
  parts.push(raw(`${q(alias)}.id ASC`));
  return join(parts, ', ');
}

const SEARCHABLE = [...TEXT_TYPES, 'SingleSelect', 'MultiSelect', 'Formula', 'Lookup'];

export function compileSearch(ctx: QueryContext, tableId: string, alias: string, search: string, searchColumnId?: string): Frag | null {
  const s = search.trim();
  if (!s) return null;
  const cols = ctx.columns(tableId);
  let targets: ColumnMeta[];
  if (searchColumnId) {
    const c = cols.find((x) => x.id === searchColumnId);
    if (!c) throw badRequest(`Unknown search field ${searchColumnId}`);
    targets = [c];
  } else {
    targets = cols.filter((c) => c.primary || SEARCHABLE.includes(c.type));
  }
  const pattern = `%${likeEscape(s)}%`;
  const parts = targets.map((c) => sql`CAST(${colExpr(ctx, c, alias)} AS TEXT) LIKE ${val(pattern)} ESCAPE '\\'`);
  if (/^\d+$/.test(s)) parts.push(sql`${raw(q(alias))}.id = ${val(Number(s))}`);
  if (!parts.length) return raw('0');
  return sql`(${join(parts, ' OR ')})`;
}
