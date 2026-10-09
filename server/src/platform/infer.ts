import type { ColumnOptions, FieldType, SelectOption } from '../../../shared/src/index.js';

/** Palette for auto-created select options (NocoDB-like pastel tones). */
export const OPTION_COLORS = ['#cfdffe', '#d0f1fd', '#c2f5e9', '#ffdaf6', '#ffdce5', '#fee2d5', '#ffeab6', '#d1f7c4', '#ede2fe', '#eeeeee'];

export const choicesFrom = (titles: string[]): SelectOption[] => titles.map((title, i) => ({ title, color: OPTION_COLORS[i % OPTION_COLORS.length] }));

export interface Inferred {
  type: FieldType;
  options?: ColumnOptions;
}

const MAX_SELECT_OPTIONS = 20;
const MAX_OPTION_LENGTH = 50;

const RE = {
  int: /^-?(0|[1-9]\d{0,14})$/,
  // no leading zeros on the integer part ("007" is a code, not a number)
  dec: /^-?((0|[1-9]\d*)(\.\d+)?|\.\d+)(e[+-]?\d+)?$/i,
  currency: /^-?[$€£¥]\s?-?\d{1,3}(,?\d{3})*(\.\d+)?$/,
  bool: /^(true|false|yes|no|y|n|checked|unchecked)$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  dateTime: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^https?:\/\/[^\s]+$/i,
};

const asText = (v: unknown): string => {
  if (v == null) return '';
  if (v instanceof Date) return dateText(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).trim();
};

/** XLSX dates: midnight UTC → date only, otherwise full ISO. */
export function dateText(d: Date): string {
  if (Number.isNaN(d.getTime())) return '';
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}

/** Infer a field type from all of a column's values. `primary` columns never become selects/checkboxes. */
export function inferType(values: unknown[], primary = false): Inferred {
  const nonEmpty = values.filter((v) => v != null && asText(v) !== '');
  if (!nonEmpty.length) return { type: 'SingleLineText' };
  const texts = nonEmpty.map(asText);
  const all = (fn: (s: string, raw: unknown) => boolean) => texts.every((s, i) => fn(s, nonEmpty[i]));

  if (!primary && all((s, raw) => typeof raw === 'boolean' || RE.bool.test(s))) return { type: 'Checkbox' };
  if (all((s, raw) => (typeof raw === 'number' && Number.isInteger(raw)) || RE.int.test(s))) return { type: 'Number' };
  if (all((s, raw) => typeof raw === 'number' || RE.dec.test(s))) {
    const decimals = Math.max(...texts.map((s) => (s.includes('.') ? s.split('.')[1].replace(/e.*/i, '').length : 0)));
    return { type: 'Decimal', options: { precision: Math.min(8, Math.max(1, decimals)) } };
  }
  if (all((s) => RE.currency.test(s))) {
    const sym = texts[0].replace(/^-/, '')[0];
    const code = ({ $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' } as Record<string, string>)[sym] ?? 'USD';
    return { type: 'Currency', options: { currencyCode: code, precision: 2 } };
  }
  if (all((s, raw) => raw instanceof Date || RE.date.test(s) || RE.dateTime.test(s))) {
    return { type: texts.every((s) => RE.date.test(s)) ? 'Date' : 'DateTime' };
  }
  if (all((s) => RE.email.test(s))) return { type: 'Email' };
  if (all((s) => RE.url.test(s))) return { type: 'URL' };

  const long = texts.some((s) => s.length > 255 || s.includes('\n'));
  if (!primary && !long) {
    const counts = new Map<string, number>();
    for (const s of texts) counts.set(s, (counts.get(s) ?? 0) + 1);
    const distinct = [...counts.keys()];
    const shortEnough = distinct.every((s) => s.length <= MAX_OPTION_LENGTH);
    // Comma-separated tags drawn from a small, repeated vocabulary → MultiSelect
    if (texts.some((s) => s.includes(','))) {
      const tokens = texts.flatMap((s) => s.split(',').map((t) => t.trim()).filter(Boolean));
      const vocab = [...new Set(tokens)];
      if (vocab.length <= MAX_SELECT_OPTIONS && tokens.length >= vocab.length * 2 && vocab.every((t) => t.length <= MAX_OPTION_LENGTH)) {
        return { type: 'MultiSelect', options: { choices: choicesFrom(vocab) } };
      }
    } else if (shortEnough && distinct.length <= MAX_SELECT_OPTIONS && texts.length >= distinct.length * 2) {
      return { type: 'SingleSelect', options: { choices: choicesFrom(distinct) } };
    }
  }
  return { type: long ? 'LongText' : 'SingleLineText' };
}

/** Convert a raw imported cell to the value shape the record API expects for `type`. */
export function convertValue(type: FieldType, raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const s = asText(raw);
  switch (type) {
    case 'Number':
    case 'Rating': {
      const n = typeof raw === 'number' ? raw : Number(s.replace(/,/g, ''));
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    case 'Decimal':
    case 'Percent':
    case 'Currency': {
      if (typeof raw === 'number') return raw;
      const n = Number(s.replace(/[$€£¥,%\s]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'Checkbox':
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'number') return raw !== 0;
      return /^(true|yes|y|1|checked|x)$/i.test(s);
    case 'Date':
      if (raw instanceof Date) return dateText(raw).slice(0, 10);
      return RE.dateTime.test(s) ? s.slice(0, 10) : s;
    case 'DateTime':
      if (raw instanceof Date) return raw.toISOString();
      return s;
    case 'MultiSelect':
      if (Array.isArray(raw)) return raw.map(asText).filter(Boolean);
      return s.split(',').map((t) => t.trim()).filter(Boolean);
    case 'JSON':
      if (typeof raw === 'object') return raw;
      try {
        return JSON.parse(s);
      } catch {
        return s;
      }
    case 'Attachment':
      if (Array.isArray(raw)) return raw;
      return s
        .split(/[,\s]+/)
        .filter((u) => /^https?:\/\//i.test(u))
        .map((url) => ({ url, title: url.split('/').pop() || url }));
    default:
      return typeof raw === 'string' ? raw : s;
  }
}
