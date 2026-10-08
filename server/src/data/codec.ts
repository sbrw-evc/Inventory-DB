/**
 * Value conversion between the API shape and the SQLite storage shape, per field type.
 */
import type { Attachment, FieldType, SelectOption } from '../../../shared/src/index.js';
import { newId } from '../db/index.js';
import { badRequest } from '../errors.js';
import type { ColumnMeta } from '../meta/store.js';

export const CHOICE_COLORS = [
  '#cfdffe',
  '#d0f1fd',
  '#c2f5e9',
  '#ffdaf6',
  '#ffdce5',
  '#fee2d5',
  '#ffeab6',
  '#d1f7c4',
  '#ede2fe',
  '#eeeeee',
];

export const TEXT_TYPES: readonly FieldType[] = ['SingleLineText', 'LongText', 'Email', 'URL', 'PhoneNumber'];
export const NUMERIC_TYPES: readonly FieldType[] = ['Number', 'Decimal', 'Currency', 'Percent', 'Rating', 'ID', 'Rollup'];
export const DATE_TYPES: readonly FieldType[] = ['Date', 'DateTime', 'CreatedTime', 'LastModifiedTime'];
/** Types whose stored value is JSON text. */
export const JSON_TYPES: readonly FieldType[] = ['MultiSelect', 'Attachment', 'JSON', 'Lookup'];

export interface CoerceOpts {
  /** strict: invalid values throw 400; lenient (type conversion/imports): invalid values become NULL */
  strict: boolean;
  /** Called after a new select option was appended to `col.options.choices`. */
  onNewChoice?: (col: ColumnMeta) => void;
}

export function newChoice(title: string, index: number): SelectOption {
  return { id: newId('opt'), title, color: CHOICE_COLORS[index % CHOICE_COLORS.length] };
}

function invalid(col: ColumnMeta, v: unknown, opts: CoerceOpts, why = ''): null {
  if (opts.strict) {
    const shown = typeof v === 'string' ? `"${v.length > 40 ? `${v.slice(0, 40)}…` : v}"` : JSON.stringify(v);
    throw badRequest(`Invalid value ${shown} for field "${col.title}" (${col.type})${why ? `: ${why}` : ''}`);
  }
  return null;
}

/** Plain-text rendering of any decoded value (used for text targets and conversions). */
export function asText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    const parts = v.map((x) => (x && typeof x === 'object' ? ((x as Attachment).url ?? (x as { display?: string }).display ?? JSON.stringify(x)) : asText(x))).filter((x) => x != null && x !== '');
    return parts.length ? parts.join(', ') : null;
  }
  return JSON.stringify(v);
}

function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const s = v.trim().replace(/[\s,]/g, '').replace(/^[$€£¥₹]/, '').replace(/%$/, '');
    if (!s || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    return Number(s);
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  // Date-only strings are calendar dates, not instants: parse as UTC midnight.
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCMonth() === +m[2] - 1 ? d : null;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', 'yes', 'y', '1', 'checked', 'x', 'on', '✓', '✔'].includes(v.trim().toLowerCase());
  return false;
}

function matchChoice(col: ColumnMeta, title: string, opts: CoerceOpts): string {
  const choices = (col.options.choices ??= []);
  const exact = choices.find((c) => c.title === title);
  if (exact) return exact.title;
  const ci = choices.find((c) => c.title.toLowerCase() === title.toLowerCase());
  if (ci) return ci.title;
  choices.push(newChoice(title, choices.length));
  opts.onNewChoice?.(col);
  return title;
}

function toList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through */
      }
    }
    return s ? s.split(',') : [];
  }
  return v == null ? [] : [v];
}

/**
 * API value -> stored SQLite value for a stored (non-virtual) column. Returns null for empty input.
 */
export function toStored(col: ColumnMeta, v: unknown, opts: CoerceOpts): string | number | null {
  if (v === undefined || v === null) return col.type === 'Checkbox' ? 0 : null;
  switch (col.type) {
    case 'SingleLineText':
    case 'LongText':
    case 'Email':
    case 'URL':
    case 'PhoneNumber': {
      let s = asText(v);
      if (s == null) return null;
      if (col.type === 'SingleLineText') s = s.replace(/[\r\n]+/g, ' ');
      if (col.type !== 'LongText') s = s.trim();
      if (col.type === 'Email' && s && !/^\S+@\S+$/.test(s)) return invalid(col, v, opts, 'not an email address');
      return s === '' ? null : s;
    }
    case 'Number':
    case 'Rating': {
      if (v === '') return null;
      const n = parseNumber(v);
      if (n == null) return invalid(col, v, opts, 'not a number');
      let r = Math.round(n);
      if (col.type === 'Rating') r = Math.max(0, Math.min(col.options.max ?? 5, r));
      return r;
    }
    case 'Decimal':
    case 'Currency':
    case 'Percent': {
      if (v === '') return null;
      const n = parseNumber(v);
      if (n == null) return invalid(col, v, opts, 'not a number');
      return n;
    }
    case 'Checkbox':
      return toBool(v) ? 1 : 0;
    case 'Date': {
      if (v === '') return null;
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim()) && parseDate(v.trim().slice(0, 10))) return v.trim().slice(0, 10);
      const d = parseDate(v);
      if (!d) return invalid(col, v, opts, 'not a date');
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    case 'DateTime': {
      if (v === '') return null;
      const d = parseDate(v);
      if (!d) return invalid(col, v, opts, 'not a date/time');
      return d.toISOString();
    }
    case 'SingleSelect': {
      const s = asText(Array.isArray(v) ? v[0] : v)?.trim();
      if (!s) return null;
      return matchChoice(col, s, opts);
    }
    case 'MultiSelect': {
      const titles: string[] = [];
      for (const item of toList(v)) {
        const s = asText(item)?.trim();
        if (!s) continue;
        const t = matchChoice(col, s, opts);
        if (!titles.includes(t)) titles.push(t);
      }
      return titles.length ? JSON.stringify(titles) : null;
    }
    case 'Attachment': {
      const out: Attachment[] = [];
      for (const item of toList(v)) {
        if (typeof item === 'string') {
          const url = item.trim();
          if (url) out.push({ url, title: decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || url) });
        } else if (item && typeof item === 'object' && typeof (item as Attachment).url === 'string') {
          const a = item as Attachment;
          out.push({
            url: a.url,
            title: a.title ?? a.url.split('/').pop() ?? a.url,
            ...(a.mimetype ? { mimetype: a.mimetype } : {}),
            ...(a.size != null ? { size: a.size } : {}),
          });
        } else return invalid(col, v, opts, 'attachments must be URLs or {url, title}');
      }
      return out.length ? JSON.stringify(out) : null;
    }
    case 'JSON': {
      if (typeof v === 'string') {
        if (v.trim() === '') return null;
        try {
          return JSON.stringify(JSON.parse(v));
        } catch {
          return JSON.stringify(v);
        }
      }
      return JSON.stringify(v);
    }
    default:
      return null;
  }
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Stored/SQL value -> API value. `resolve` finds columns of other tables (for Lookup targets).
 */
export function fromStored(col: ColumnMeta, v: unknown, resolve: (id: string) => ColumnMeta | undefined, detailedLinks = false): unknown {
  switch (col.type) {
    case 'Checkbox':
      return v == null ? false : !!v;
    case 'MultiSelect':
    case 'Attachment': {
      if (v == null) return null;
      const parsed = parseJson(v);
      return Array.isArray(parsed) ? parsed : null;
    }
    case 'JSON':
      return v == null ? null : parseJson(v);
    case 'Links':
      if (detailedLinks) {
        const arr = v == null ? [] : (parseJson(v) as { id: number; display: unknown }[]);
        return Array.isArray(arr) ? arr.map((x) => ({ id: x.id, display: x.display == null ? '' : String(x.display) })) : [];
      }
      return v == null ? 0 : Number(v);
    case 'Rollup':
      return v == null ? null : typeof v === 'number' ? v : Number(v);
    case 'Lookup': {
      const arr = v == null ? [] : parseJson(v);
      if (!Array.isArray(arr)) return [];
      const target = col.options.targetColumnId ? resolve(col.options.targetColumnId) : undefined;
      const out: unknown[] = [];
      for (const item of arr) {
        if (item == null) continue;
        const d = target ? fromStored(target, typeof item === 'object' ? JSON.stringify(item) : item, resolve) : item;
        if (target && (target.type === 'MultiSelect' || target.type === 'Attachment' || target.type === 'Lookup') && Array.isArray(d)) out.push(...d);
        else if (d != null && d !== '') out.push(d);
      }
      return out;
    }
    default:
      return v ?? null;
  }
}
