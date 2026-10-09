import type { FilterCondition, FilterGroup } from '../../../shared/src/index.js';
import { isFilterGroup } from '../../../shared/src/index.js';

/**
 * In-memory evaluation of a FilterGroup against a decoded record (keys = column ids).
 * Mirrors the SQL query compiler's semantics closely enough for webhook conditions.
 */
export function matchesFilter(group: FilterGroup | null | undefined, record: Record<string, unknown>): boolean {
  if (!group || !group.children?.length) return true;
  const results = group.children.map((c) => (isFilterGroup(c) ? matchesFilter(c, record) : matchesCondition(c, record)));
  return group.logic === 'or' ? results.some(Boolean) : results.every(Boolean);
}

const isBlank = (v: unknown) =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Lists (MultiSelect, Lookup, Attachment, Links) compare by their textual members. */
function toList(v: unknown): string[] {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(text);
  if (typeof v === 'string' && v.includes(',')) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [text(v)];
}

function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('display' in o) return text(o.display);
    if ('title' in o) return text(o.title);
    return JSON.stringify(v);
  }
  return String(v);
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
};

/** Compare numerically when both sides are numbers, else as strings (ISO dates sort lexically). */
function compare(a: unknown, b: unknown): number {
  if (Array.isArray(a)) a = a.length;
  const na = num(a);
  const nb = num(b);
  if (na != null && nb != null) return na - nb;
  return text(a).localeCompare(text(b));
}

function withinRange(v: unknown, range: unknown): boolean {
  const d = new Date(text(v));
  if (Number.isNaN(d.getTime())) return false;
  const nowMs = Date.now();
  const day = 86400000;
  const spans: Record<string, [number, number]> = {
    pastWeek: [nowMs - 7 * day, nowMs],
    pastMonth: [nowMs - 30 * day, nowMs],
    pastYear: [nowMs - 365 * day, nowMs],
    nextWeek: [nowMs, nowMs + 7 * day],
    nextMonth: [nowMs, nowMs + 30 * day],
    nextYear: [nowMs, nowMs + 365 * day],
  };
  const span = spans[text(range)];
  if (!span) return false;
  const t = d.getTime();
  return t >= span[0] - day && t <= span[1] + day;
}

export function matchesCondition(c: FilterCondition, record: Record<string, unknown>): boolean {
  const v = record[c.columnId];
  const target = c.value;
  switch (c.op) {
    case 'blank':
      return isBlank(v);
    case 'notblank':
      return !isBlank(v);
    case 'checked':
      return v === true || v === 1 || v === '1' || v === 'true';
    case 'notchecked':
      return !(v === true || v === 1 || v === '1' || v === 'true');
    case 'eq':
      if (isBlank(target)) return isBlank(v);
      if (Array.isArray(v)) return toList(v).some((x) => x.toLowerCase() === text(target).toLowerCase());
      if (num(v) != null && num(target) != null) return num(v) === num(target);
      return text(v).toLowerCase() === text(target).toLowerCase();
    case 'neq':
      return !matchesCondition({ ...c, op: 'eq' }, record);
    case 'like':
      return toList(v).join(', ').toLowerCase().includes(text(target).toLowerCase());
    case 'nlike':
      return !toList(v).join(', ').toLowerCase().includes(text(target).toLowerCase());
    case 'gt':
      return !isBlank(v) && compare(v, target) > 0;
    case 'gte':
      return !isBlank(v) && compare(v, target) >= 0;
    case 'lt':
      return !isBlank(v) && compare(v, target) < 0;
    case 'lte':
      return !isBlank(v) && compare(v, target) <= 0;
    case 'anyof':
    case 'nanyof':
    case 'allof':
    case 'nallof': {
      const have = new Set(toList(v).map((s) => s.toLowerCase()));
      const want = toList(target).map((s) => s.toLowerCase());
      const any = want.some((w) => have.has(w));
      const all = want.length > 0 && want.every((w) => have.has(w));
      return c.op === 'anyof' ? any : c.op === 'nanyof' ? !any : c.op === 'allof' ? all : !all;
    }
    case 'isWithin':
      return withinRange(v, target);
    default:
      return false;
  }
}
