import type { Column, FilterGroup } from '@shared';
import { parseYmd, toDateInput, ymd } from './format';

/** Calendar/timeline helpers for records placed by a start (and optional end) Date/DateTime field. */

export const DATE_FIELD_TYPES = ['Date', 'DateTime', 'CreatedTime', 'LastModifiedTime'];
export const EDITABLE_DATE_TYPES = ['Date', 'DateTime'];

export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const DAY_MS = 86_400_000;

/** Whole days from `a` to `b` (local calendar days, DST-safe). */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY_MS);
}

/** Local day ('YYYY-MM-DD') of a stored Date/DateTime value. */
export function dayKey(column: Column, v: unknown): string | null {
  if (!v) return null;
  if (column.type === 'Date') return toDateInput(v) || null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : ymd(d);
}

export function dayOf(column: Column, v: unknown): Date | null {
  const k = dayKey(column, v);
  return k ? parseYmd(k) : null;
}

/** Moves a value to another day, keeping the time of day for DateTime fields (09:00 when there was none). */
export function moveToDay(column: Column, v: unknown, day: string): string {
  if (column.type === 'Date') return day;
  const target = parseYmd(day)!;
  const old = v ? new Date(String(v)) : null;
  if (old && !Number.isNaN(old.getTime())) target.setHours(old.getHours(), old.getMinutes(), old.getSeconds());
  else target.setHours(9, 0, 0);
  return target.toISOString();
}

/** Shifts a value by `n` days. */
export function shiftDays(column: Column, v: unknown, n: number): string | null {
  const d = dayOf(column, v);
  if (!d) return null;
  return moveToDay(column, v, ymd(addDays(d, n)));
}

/**
 * Records overlapping [from, to) (YYYY-MM-DD): start < to and (end >= from, or no end and start >= from).
 */
export function overlapFilter(start: Column, end: Column | undefined, from: string, to: string): FilterGroup {
  if (!end) {
    return {
      logic: 'and',
      children: [
        { columnId: start.id, op: 'gte', value: from },
        { columnId: start.id, op: 'lt', value: to },
      ],
    };
  }
  return {
    logic: 'and',
    children: [
      { columnId: start.id, op: 'lt', value: to },
      {
        logic: 'or',
        children: [
          { columnId: end.id, op: 'gte', value: from },
          {
            logic: 'and',
            children: [
              { columnId: end.id, op: 'blank' },
              { columnId: start.id, op: 'gte', value: from },
            ],
          },
        ],
      },
    ],
  };
}

/** Start and end day of a record (end defaults to start, and never precedes it). */
export function spanOf(row: Record<string, unknown>, start: Column, end?: Column): { start: Date; end: Date } | null {
  const s = dayOf(start, row[start.id]);
  if (!s) return null;
  const e = end ? dayOf(end, row[end.id]) : null;
  return { start: s, end: e && e >= s ? e : s };
}
