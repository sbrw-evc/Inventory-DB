import type { Attachment, Column, FieldType } from '@shared';
import { formatGeo, parseGeo } from '@shared';
import { t } from '../i18n';

const pad = (n: number) => String(n).padStart(2, '0');

export const NUMERIC_TYPES: readonly FieldType[] = ['Number', 'Decimal', 'Currency', 'Percent', 'Rating', 'ID'];

export function isNumericType(t: FieldType) {
  return NUMERIC_TYPES.includes(t);
}

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(String(v).replace(/[\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function defaultPrecision(type: FieldType): number {
  switch (type) {
    case 'Decimal':
    case 'Currency':
      return 2;
    case 'Percent':
      return 0;
    default:
      return 0;
  }
}

export function formatNumber(column: Pick<Column, 'type' | 'options'>, v: unknown): string {
  const n = toNumber(v);
  if (n === null) return v === null || v === undefined ? '' : String(v);
  const precision = column.options?.precision ?? defaultPrecision(column.type);
  switch (column.type) {
    case 'Currency': {
      const code = column.options?.currencyCode || 'USD';
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: code,
          minimumFractionDigits: precision,
          maximumFractionDigits: precision,
        }).format(n);
      } catch {
        return `${code} ${n.toFixed(precision)}`;
      }
    }
    case 'Percent':
      return `${n.toFixed(precision)}%`;
    case 'Number':
    case 'ID':
      return column.type === 'ID' ? String(n) : n.toLocaleString(undefined, { maximumFractionDigits: precision });
    default:
      return n.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision });
  }
}

/** 'YYYY-MM-DD' for a Date in local time. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parses 'YYYY-MM-DD' as a local date (not UTC). */
export function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Value for <input type="date"> from a stored Date/DateTime value. */
export function toDateInput(v: unknown): string {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : ymd(d);
}

/** Value for <input type="datetime-local"> from an ISO string. */
export function toDateTimeInput(v: unknown): string {
  if (!v) return '';
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? parseYmd(s) : new Date(s);
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local input value → ISO string (UTC). */
export function fromDateTimeInput(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatDate(v: unknown, withTime: boolean): string {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? parseYmd(s) : new Date(s);
  if (!d || Number.isNaN(d.getTime())) return s;
  const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (!withTime) return date;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function asArray(v: unknown): unknown[] {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }
  return [v];
}

export function asAttachments(v: unknown): Attachment[] {
  return asArray(v).filter((a): a is Attachment => !!a && typeof a === 'object' && 'url' in (a as object));
}

export function asStringList(v: unknown): string[] {
  if (typeof v === 'string' && !v.startsWith('[')) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return asArray(v).map((x) => String(x));
}

/** Display value as plain text (cells, copy, kanban/gallery cards). */
export function formatValue(column: Pick<Column, 'type' | 'options'>, v: unknown): string {
  if (v === null || v === undefined) return '';
  switch (column.type) {
    case 'Number':
    case 'Decimal':
    case 'Currency':
    case 'Percent':
    case 'ID':
      return formatNumber(column, v);
    case 'Rating':
      return toNumber(v) === null ? '' : String(toNumber(v));
    case 'Checkbox':
      return v === true || v === 1 || v === '1' || v === 'true' ? 'true' : 'false';
    case 'Date':
      return formatDate(v, false);
    case 'DateTime':
    case 'CreatedTime':
    case 'LastModifiedTime':
      return formatDate(v, true);
    case 'MultiSelect':
      return asStringList(v).join(', ');
    case 'Attachment':
      return asAttachments(v)
        .map((a) => a.title || a.url)
        .join(', ');
    case 'JSON':
      return typeof v === 'string' ? v : JSON.stringify(v);
    case 'Links':
      if (typeof v === 'number') return v === 1 ? t('1 record') : t('{n} records', { n: v });
      return asArray(v).map(displayOf).join(', ');
    case 'Lookup':
    case 'Rollup':
    case 'Formula':
      return Array.isArray(v) ? v.map(displayOf).join(', ') : displayOf(v);
    default:
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

function displayOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('display' in o) return String(o.display ?? '');
    if ('title' in o) return String(o.title);
    return JSON.stringify(v);
  }
  return String(v);
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'x', 'checked', '✓', '✔', 'on']);

/** Normalises a date-ish string to 'YYYY-MM-DD', or null. */
export function normalizeDate(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(t);
  if (dmy) return `${dmy[3]}-${pad(Number(dmy[2]))}-${pad(Number(dmy[1]))}`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : ymd(d);
}

/**
 * Parses user-typed or pasted text into the API value for the column type.
 * Returns `undefined` when the text can't be interpreted (caller should ignore it).
 */
export function parseInputValue(column: Pick<Column, 'type' | 'options'>, text: string): unknown {
  const t = text.trim();
  switch (column.type) {
    case 'Number':
    case 'Rating': {
      if (!t) return null;
      const n = toNumber(t.replace(/[^\d.,-]/g, ''));
      return n === null ? undefined : Math.round(n);
    }
    case 'Decimal':
    case 'Currency':
    case 'Percent': {
      if (!t) return null;
      const n = toNumber(t.replace(/[^\d.,-]/g, ''));
      return n === null ? undefined : n;
    }
    case 'Checkbox':
      return TRUE_WORDS.has(t.toLowerCase());
    case 'Date': {
      if (!t) return null;
      return normalizeDate(t) ?? undefined;
    }
    case 'DateTime': {
      if (!t) return null;
      const d = new Date(t);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    case 'MultiSelect': {
      if (!t) return [];
      if (t.startsWith('[')) {
        try {
          const arr = JSON.parse(t);
          if (Array.isArray(arr)) return arr.map(String);
        } catch {
          /* fall through */
        }
      }
      return t.split(',').map((s) => s.trim()).filter(Boolean);
    }
    case 'SingleSelect':
      return t || null;
    case 'JSON': {
      if (!t) return null;
      try {
        return JSON.parse(t);
      } catch {
        return undefined;
      }
    }
    case 'Attachment':
      return undefined;
    case 'GeoData': {
      if (!t) return null;
      const p = parseGeo(t);
      return p ? formatGeo(p) : undefined;
    }
    default:
      return text === '' ? null : text;
  }
}

/** Plain text for clipboard copy (selects/arrays become comma lists, JSON stays JSON). */
export function toClipboardText(column: Pick<Column, 'type' | 'options'>, v: unknown): string {
  if (v === null || v === undefined) return '';
  switch (column.type) {
    case 'Date':
      return toDateInput(v);
    case 'DateTime':
      return String(v);
    case 'Number':
    case 'Decimal':
    case 'Currency':
    case 'Percent':
    case 'Rating':
      return String(v);
    case 'JSON':
      return typeof v === 'string' ? v : JSON.stringify(v);
    default:
      return formatValue(column, v);
  }
}

export function formatBytes(n?: number): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function isImage(a: Attachment): boolean {
  if (a.mimetype) return a.mimetype.startsWith('image/');
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?|$)/i.test(a.url);
}

export function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (Number.isNaN(diff)) return iso;
  if (diff < 60) return t('just now');
  if (diff < 3600) return t('{n}m ago', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('{n}h ago', { n: Math.floor(diff / 3600) });
  if (diff < 86400 * 7) return t('{n}d ago', { n: Math.floor(diff / 86400) });
  return d.toLocaleDateString();
}
