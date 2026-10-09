/**
 * Pure mapping helpers from NocoDB (v2 API) metadata and values to Inventory DB's model.
 * No I/O here so every rule is unit-testable.
 */
import {
  opsForType,
  type Attachment,
  type ColumnOptions,
  type FieldType,
  type FilterCondition,
  type FilterGroup,
  type FilterOp,
  type RollupFunction,
  type SelectOption,
  type Sort,
  type ViewType,
} from '../../../shared/src/index.js';
import type { NocoColumn, NocoFilter, NocoSort } from './nocodbClient.js';

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

export function parseMeta(meta: unknown): Record<string, unknown> {
  if (meta && typeof meta === 'object') return meta as Record<string, unknown>;
  if (typeof meta === 'string' && meta.trim()) {
    try {
      const v = JSON.parse(meta);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }
  return {};
}

// ---------------------------------------------------------------- columns

export type RelationType = 'mm' | 'hm' | 'bt';

/** What to do with one NocoDB column. */
export type ColumnPlan =
  /** Not migrated. `systemTarget` maps it onto one of our auto-generated system columns (for filters/sorts). */
  | { kind: 'skip'; reason: string; systemTarget?: 'ID' | 'CreatedTime' | 'LastModifiedTime'; silent?: boolean }
  /** A stored column. `note` is set when the type had to be converted. */
  | { kind: 'stored'; type: FieldType; options: ColumnOptions; note?: string }
  | { kind: 'link'; relation: RelationType; relatedTableId: string; note?: string }
  | { kind: 'lookup'; relationColumnId: string; lookupColumnId: string }
  | { kind: 'rollup'; relationColumnId: string; rollupColumnId: string; rollupFunction: RollupFunction; note?: string }
  | { kind: 'formula'; formula: string };

/** Fixed palette used when NocoDB options carry no colour. */
const COLORS = ['#cfdffe', '#d0f1fd', '#c2f5e9', '#ffdaf6', '#ffdce5', '#fee2d5', '#ffeab6', '#d1f7c4', '#ede2fe', '#eeeeee'];

export function mapSelectOptions(col: NocoColumn): SelectOption[] {
  const raw = col.colOptions?.options;
  let options: { title: string; color?: string; order?: number }[] = Array.isArray(raw) ? raw : [];
  if (!options.length && typeof col.dtxp === 'string' && col.dtxp) {
    // Very old NocoDB versions keep choices in dtxp as "'a','b'".
    options = col.dtxp.split(',').map((s) => ({ title: s.trim().replace(/^'|'$/g, '') }));
  }
  const seen = new Set<string>();
  return [...options]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((o) => typeof o.title === 'string' && o.title !== '' && !seen.has(o.title) && seen.add(o.title))
    .map((o, i) => ({ title: o.title, color: o.color || COLORS[i % COLORS.length]! }));
}

const ROLLUP_MAP: Record<string, RollupFunction> = {
  count: 'count',
  sum: 'sum',
  avg: 'avg',
  min: 'min',
  max: 'max',
  countDistinct: 'countDistinct',
  sumDistinct: 'sumDistinct',
  avgDistinct: 'avg',
};

export function mapRollupFunction(fn: string | undefined): { fn: RollupFunction; note?: string } | null {
  if (!fn) return { fn: 'count' };
  const mapped = ROLLUP_MAP[fn];
  if (!mapped) return null;
  return fn === 'avgDistinct' ? { fn: mapped, note: 'rollup avgDistinct migrated as avg' } : { fn: mapped };
}

export function mapRelationType(t: string | undefined): { relation: RelationType; note?: string } {
  switch (t) {
    case 'hm':
    case 'om':
      return { relation: 'hm' };
    case 'bt':
    case 'mo':
      return { relation: 'bt' };
    case 'oo':
      return { relation: 'bt', note: 'one-to-one link migrated as a belongs-to link' };
    default:
      return { relation: 'mm' };
  }
}

const isLinkUidt = (uidt: string) => uidt === 'Links' || uidt === 'LinkToAnotherRecord';

export function isLinkColumn(col: NocoColumn): boolean {
  return isLinkUidt(col.uidt);
}

/**
 * Key shared by both sides of one NocoDB relation, so we create only one Links column (our engine creates the
 * symmetric side). Returns null when the column options are too sparse to pair reliably.
 */
export function relationKey(col: NocoColumn): string | null {
  const o = col.colOptions;
  if (!o) return null;
  if (o.fk_mm_model_id) return `mm:${o.fk_mm_model_id}`;
  if (o.fk_child_column_id && o.fk_parent_column_id) return `fk:${o.fk_child_column_id}:${o.fk_parent_column_id}`;
  return null;
}

/** Type conversion table for NocoDB `uidt`. */
export function planColumn(col: NocoColumn): ColumnPlan {
  const meta = parseMeta(col.meta);
  const uidt = col.uidt;
  if (truthy(col.pk) || uidt === 'ID') return { kind: 'skip', reason: 'primary key (we generate our own ids)', systemTarget: 'ID', silent: true };
  if (uidt === 'CreatedTime' || uidt === 'LastModifiedTime') {
    return {
      kind: 'skip',
      reason: `${uidt} (our own ${uidt} column is used; original timestamps are not preserved)`,
      systemTarget: uidt,
      silent: truthy(col.system),
    };
  }
  if (uidt === 'ForeignKey') return { kind: 'skip', reason: 'foreign key (represented by the Links field)', silent: true };
  if (truthy(col.system) && !isLinkUidt(uidt)) return { kind: 'skip', reason: 'system column', silent: true };

  const precision = typeof meta.precision === 'number' ? meta.precision : undefined;
  switch (uidt) {
    case 'SingleLineText':
    case 'LongText':
    case 'Email':
    case 'URL':
    case 'PhoneNumber':
    case 'JSON':
    case 'Checkbox':
    case 'Attachment':
      return { kind: 'stored', type: uidt, options: {} };
    case 'Number':
      return { kind: 'stored', type: 'Number', options: {} };
    case 'Decimal':
      return { kind: 'stored', type: 'Decimal', options: precision !== undefined ? { precision } : {} };
    case 'Percent':
      return { kind: 'stored', type: 'Percent', options: precision !== undefined ? { precision } : {} };
    case 'Currency': {
      const options: ColumnOptions = {};
      if (typeof meta.currency_code === 'string') options.currencyCode = meta.currency_code;
      if (precision !== undefined) options.precision = precision;
      return { kind: 'stored', type: 'Currency', options };
    }
    case 'Rating': {
      const options: ColumnOptions = {};
      if (typeof meta.max === 'number') options.max = meta.max;
      if (typeof meta.icon === 'object' && meta.icon && typeof (meta.icon as { full?: unknown }).full === 'string') {
        options.icon = (meta.icon as { full: string }).full;
      }
      return { kind: 'stored', type: 'Rating', options };
    }
    case 'Date':
    case 'DateTime': {
      const options: ColumnOptions = {};
      if (typeof meta.date_format === 'string') options.dateFormat = meta.date_format;
      return { kind: 'stored', type: uidt, options };
    }
    case 'SingleSelect':
    case 'MultiSelect':
      return { kind: 'stored', type: uidt, options: { choices: mapSelectOptions(col) } };
    case 'RichText':
      return { kind: 'stored', type: 'LongText', options: {}, note: 'RichText converted to LongText (markdown kept as text)' };
    case 'Year':
      return { kind: 'stored', type: 'Number', options: {}, note: 'Year converted to Number' };
    case 'AutoNumber':
      return { kind: 'stored', type: 'Number', options: {}, note: 'AutoNumber converted to Number (values copied)' };
    case 'Time':
      return { kind: 'stored', type: 'SingleLineText', options: {}, note: 'Time converted to text (HH:mm:ss)' };
    case 'Duration':
      return { kind: 'stored', type: 'SingleLineText', options: {}, note: 'Duration converted to text (h:mm:ss)' };
    case 'User':
    case 'CreatedBy':
    case 'LastModifiedBy':
    case 'Collaborator':
      return { kind: 'stored', type: 'SingleLineText', options: {}, note: `${uidt} converted to text (user names/emails)` };
    case 'GeoData':
      return { kind: 'stored', type: 'GeoData', options: {} };
    case 'SpecificDBType':
      return { kind: 'stored', type: 'SingleLineText', options: {}, note: 'database-specific type converted to text' };
    case 'Barcode':
    case 'QRCode':
    case 'Button':
      return { kind: 'skip', reason: `${uidt} fields are not supported` };
    case 'Links':
    case 'LinkToAnotherRecord': {
      const o = col.colOptions;
      if (!o?.fk_related_model_id) return { kind: 'skip', reason: 'link without a related table' };
      const r = mapRelationType(o.type);
      return { kind: 'link', relation: r.relation, relatedTableId: o.fk_related_model_id, ...(r.note ? { note: r.note } : {}) };
    }
    case 'Lookup': {
      const o = col.colOptions;
      if (!o?.fk_relation_column_id || !o.fk_lookup_column_id) return { kind: 'skip', reason: 'lookup without link/target' };
      return { kind: 'lookup', relationColumnId: o.fk_relation_column_id, lookupColumnId: o.fk_lookup_column_id };
    }
    case 'Rollup': {
      const o = col.colOptions;
      if (!o?.fk_relation_column_id || !o.fk_rollup_column_id) return { kind: 'skip', reason: 'rollup without link/target' };
      const fn = mapRollupFunction(o.rollup_function);
      if (!fn) return { kind: 'skip', reason: `rollup function "${o.rollup_function}" is not supported` };
      return {
        kind: 'rollup',
        relationColumnId: o.fk_relation_column_id,
        rollupColumnId: o.fk_rollup_column_id,
        rollupFunction: fn.fn,
        ...(fn.note ? { note: fn.note } : {}),
      };
    }
    case 'Formula': {
      const o = col.colOptions;
      const f = o?.formula_raw ?? o?.formula;
      if (typeof f !== 'string' || !f.trim()) return { kind: 'skip', reason: 'formula without an expression' };
      return { kind: 'formula', formula: f };
    }
    default:
      return { kind: 'stored', type: 'SingleLineText', options: {}, note: `${uidt} converted to text` };
  }
}

// ---------------------------------------------------------------- formulas

/** Titles referenced as `{Field}` in a formula. */
export function formulaRefs(formula: string): string[] {
  return [...formula.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!.trim());
}

/**
 * Produces our formula text: NocoDB's `formula_raw` already uses `{Field Title}`; the stored `formula` may use
 * `{{columnId}}` or `{columnId}`, which we resolve via `titleById`. `renames` maps NocoDB titles to the titles we
 * used (when one had to be de-duplicated).
 */
export function rewriteFormula(formula: string, titleById: Map<string, string>, renames: Map<string, string>): string {
  const resolve = (name: string) => {
    const title = titleById.get(name) ?? name;
    return `{${renames.get(title) ?? title}}`;
  };
  return formula.replace(/\{\{([^{}]+)\}\}|\{([^{}]+)\}/g, (_, id: string | undefined, n: string | undefined) => resolve((id ?? n ?? '').trim()));
}

/** Picks a title not yet used in `taken` (lower-cased set), suffixing " 2", " 3"... */
export function uniqueTitle(title: string, taken: Set<string>): string {
  const base = title.trim() || 'Field';
  let t = base;
  for (let i = 2; taken.has(t.toLowerCase()); i++) t = `${base} ${i}`;
  taken.add(t.toLowerCase());
  return t;
}

// ---------------------------------------------------------------- views

export function mapViewType(type: number | string | undefined): ViewType | null {
  switch (type) {
    case 1:
    case 'form':
      return 'form';
    case 2:
    case 'gallery':
      return 'gallery';
    case 3:
    case 'grid':
      return 'grid';
    case 4:
    case 'kanban':
      return 'kanban';
    case 6:
    case 'calendar':
      return 'calendar';
    case 5:
    case 'map':
      return 'map';
    default:
      return null;
  }
}

const VIEW_TYPE_NAMES: Record<number, string> = { 7: 'list', 8: 'timeline', 9: 'gantt' };
export const viewTypeName = (type: number | string | undefined) =>
  typeof type === 'number' ? (VIEW_TYPE_NAMES[type] ?? `type ${type}`) : String(type);

/** "200px" | 200 → 200 */
export function parseWidth(w: unknown): number | undefined {
  if (typeof w === 'number' && Number.isFinite(w)) return w;
  if (typeof w === 'string') {
    const n = parseFloat(w);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return undefined;
}

// ---------------------------------------------------------------- filters

export interface MappedColumnRef {
  id: string;
  type: FieldType;
}

const WITHIN: Record<string, string> = {
  pastWeek: 'pastWeek',
  pastMonth: 'pastMonth',
  pastYear: 'pastYear',
  nextWeek: 'nextWeek',
  nextMonth: 'nextMonth',
  nextYear: 'nextYear',
};

const NUMERIC: FieldType[] = ['Number', 'Decimal', 'Currency', 'Percent', 'Rating', 'ID', 'Rollup'];
const DATE: FieldType[] = ['Date', 'DateTime', 'CreatedTime', 'LastModifiedTime'];

function filterValue(type: FieldType, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (NUMERIC.includes(type)) {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(n) && String(value).trim() !== '' ? n : value;
  }
  return value;
}

const splitList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(String)
    : String(value ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

/**
 * Maps one NocoDB comparison (op + sub-op + value) for a column of our `type`.
 * Returns `{ skip }` with a reason when there's no equivalent.
 */
export function mapFilterOp(
  op: string | null | undefined,
  subOp: string | null | undefined,
  value: unknown,
  type: FieldType,
): { op: FilterOp; value?: unknown } | { skip: string } {
  const isDate = DATE.includes(type);
  let out: { op: FilterOp; value?: unknown } | null = null;
  switch (op) {
    case 'eq':
    case 'neq':
    case 'is':
    case 'isnot':
    case 'not': {
      const neg = op === 'neq' || op === 'isnot' || op === 'not';
      if (type === 'Checkbox') {
        const on = truthy(value);
        out = { op: on !== neg ? 'checked' : 'notchecked' };
        break;
      }
      if (isDate && subOp && subOp !== 'exactDate') return { skip: `relative date comparison "${subOp}"` };
      if (type === 'MultiSelect') {
        out = { op: neg ? 'nallof' : 'allof', value: splitList(value) };
        break;
      }
      out = { op: neg ? 'neq' : 'eq', value: filterValue(type, value) };
      break;
    }
    case 'like':
    case 'nlike':
      out = { op, value: typeof value === 'string' ? value.replace(/^%|%$/g, '') : value };
      break;
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte':
    case 'ge':
    case 'le': {
      if (isDate && subOp && subOp !== 'exactDate') return { skip: `relative date comparison "${subOp}"` };
      const o = op === 'ge' ? 'gte' : op === 'le' ? 'lte' : op;
      out = { op: o, value: filterValue(type, value) };
      break;
    }
    case 'blank':
    case 'empty':
    case 'null':
      out = { op: 'blank' };
      break;
    case 'notblank':
    case 'notempty':
    case 'notnull':
      out = { op: 'notblank' };
      break;
    case 'checked':
    case 'notchecked':
      out = { op };
      break;
    case 'anyof':
    case 'allof':
    case 'nanyof':
    case 'nallof':
      out = { op, value: splitList(value) };
      break;
    case 'isWithin': {
      const v = subOp ? WITHIN[subOp] : undefined;
      if (!v) return { skip: `date range "${subOp}"` };
      out = { op: 'isWithin', value: v };
      break;
    }
    default:
      return { skip: `comparison "${op}"` };
  }
  if (!opsForType(type).includes(out.op)) return { skip: `comparison "${op}" on a ${type} field` };
  return out;
}

/**
 * Converts a NocoDB filter tree (roots, groups with `children`) to our FilterGroup.
 * NocoDB stores the AND/OR on each sibling (`logical_op`); a group's logic is taken from its children's ops
 * (the first child's op is ignored by NocoDB's UI, so we prefer the second).
 */
export function mapFilters(
  roots: NocoFilter[],
  columns: Map<string, MappedColumnRef>,
): { filter: FilterGroup | null; skipped: string[] } {
  const skipped: string[] = [];
  const logicOf = (list: NocoFilter[]): 'and' | 'or' => {
    const op = (list[1] ?? list[0])?.logical_op;
    if (op === 'not') skipped.push('NOT filter group treated as AND');
    return op === 'or' ? 'or' : 'and';
  };
  const convert = (list: NocoFilter[]): FilterGroup => {
    const sorted = [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const children: Array<FilterCondition | FilterGroup> = [];
    for (const f of sorted) {
      if (truthy(f.is_group)) {
        const g = convert(f.children ?? []);
        if (g.children.length) children.push(g);
        continue;
      }
      if (!f.fk_column_id) continue;
      const col = columns.get(f.fk_column_id);
      if (!col) {
        skipped.push(`filter on a column that was not migrated`);
        continue;
      }
      const m = mapFilterOp(f.comparison_op, f.comparison_sub_op, f.value, col.type);
      if ('skip' in m) {
        skipped.push(`filter ${m.skip}`);
        continue;
      }
      children.push(m.value === undefined ? { columnId: col.id, op: m.op } : { columnId: col.id, op: m.op, value: m.value });
    }
    return { logic: logicOf(sorted), children };
  };
  const g = convert(roots);
  return { filter: g.children.length ? g : null, skipped };
}

export function mapSorts(sorts: NocoSort[], columns: Map<string, MappedColumnRef>): { sorts: Sort[]; skipped: string[] } {
  const out: Sort[] = [];
  const skipped: string[] = [];
  for (const s of [...sorts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const col = columns.get(s.fk_column_id);
    if (!col) {
      skipped.push('sort on a column that was not migrated');
      continue;
    }
    out.push({ columnId: col.id, direction: s.direction === 'desc' ? 'desc' : 'asc' });
  }
  return { sorts: out, skipped };
}

// ---------------------------------------------------------------- values

export interface ValueContext {
  /** Normalised NocoDB base URL, used to absolutise attachment paths of self-hosted local storage. */
  baseUrl: string;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDuration(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  let s = Math.abs(Math.round(seconds));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${sign}${h}:${pad(m)}:${pad(s)}`;
}

function toDateTime(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  // NocoDB returns "2024-03-01 10:00:00+00:00"; make it ISO-parsable.
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(' ', 'T') : s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function toDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1]!;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s || !'[{'.includes(s[0]!)) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

export function convertAttachments(v: unknown, ctx: ValueContext): Attachment[] {
  const raw = parseMaybeJson(v);
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const out: Attachment[] = [];
  for (const item of list as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue;
    const str = (k: string) => (typeof item[k] === 'string' && item[k] ? (item[k] as string) : undefined);
    const path = str('path') ?? str('signedPath');
    const url = str('url') ?? str('signedUrl') ?? (path ? `${ctx.baseUrl}/${path.replace(/^\/+/, '')}` : undefined);
    if (!url) continue;
    const a: Attachment = { url, title: str('title') ?? decodeURIComponent(url.split('?')[0]!.split('/').pop() || 'file') };
    if (str('mimetype')) a.mimetype = str('mimetype');
    const size = toNumber(item.size);
    if (size !== null) a.size = size;
    out.push(a);
  }
  return out;
}

function userText(v: unknown): string | null {
  const raw = parseMaybeJson(v);
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const names = list
    .map((u) => {
      if (u && typeof u === 'object') {
        const o = u as Record<string, unknown>;
        return String(o.display_name || o.email || o.id || '');
      }
      return String(u);
    })
    .filter(Boolean);
  return names.length ? names.join(', ') : null;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Converts one NocoDB cell value (as returned by the v2 records API) to the value our engine expects for
 * `target`. `sourceUidt` is the original NocoDB type (matters for converted types).
 */
export function convertValue(sourceUidt: string, target: FieldType, v: unknown, ctx: ValueContext): unknown {
  if (v === undefined) return undefined;
  switch (sourceUidt) {
    case 'User':
    case 'CreatedBy':
    case 'LastModifiedBy':
    case 'Collaborator':
      return userText(v);
    case 'Duration': {
      const n = toNumber(v);
      return n === null ? text(v) : formatDuration(n);
    }
    case 'Time': {
      if (v === null || v === '') return null;
      const m = /(\d{1,2}:\d{2}(?::\d{2})?)/.exec(String(v));
      return m ? m[1]! : String(v);
    }
  }
  switch (target) {
    case 'Number':
    case 'Rating': {
      const n = toNumber(v);
      return n === null ? null : Math.round(n);
    }
    case 'Decimal':
    case 'Currency':
    case 'Percent':
      return toNumber(v);
    case 'Checkbox':
      if (v === null || v === '') return false;
      return truthy(v) || v === 'checked' || (typeof v === 'number' && v !== 0);
    case 'Date':
      return toDate(v);
    case 'DateTime':
      return toDateTime(v);
    case 'SingleSelect':
      return v === null || v === '' ? null : String(v);
    case 'MultiSelect':
      if (v === null || v === '') return [];
      return splitList(parseMaybeJson(v));
    case 'Attachment':
      return v === null ? [] : convertAttachments(v, ctx);
    case 'JSON':
      return parseMaybeJson(v);
    default:
      return text(v);
  }
}
