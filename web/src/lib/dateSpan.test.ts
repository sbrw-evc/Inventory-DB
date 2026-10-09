import { describe, expect, it } from 'vitest';
import type { Column } from '@shared';
import { daysBetween, overlapFilter, shiftDays, spanOf } from './dateSpan';
import { normalizeForList } from './records';

const col = (id: string, type: Column['type']): Column => ({ id, tableId: 't', title: id, type, primary: false, required: false, options: {}, order: 0 });
const start = col('s', 'Date');
const end = col('e', 'Date');

describe('date spans', () => {
  it('computes spans, never ending before the start', () => {
    const span = spanOf({ s: '2026-10-01', e: '2026-10-05' }, start, end)!;
    expect(daysBetween(span.start, span.end)).toBe(4);
    const bad = spanOf({ s: '2026-10-05', e: '2026-10-01' }, start, end)!;
    expect(bad.end).toEqual(bad.start);
    expect(spanOf({ s: null }, start, end)).toBeNull();
  });

  it('shifts Date and DateTime values by days', () => {
    expect(shiftDays(start, '2026-10-30', 3)).toBe('2026-11-02');
    const dt = col('d', 'DateTime');
    const moved = new Date(shiftDays(dt, new Date(2026, 9, 1, 14, 30).toISOString(), -1)!);
    expect([moved.getDate(), moved.getHours(), moved.getMinutes()]).toEqual([30, 14, 30]);
  });

  it('builds an overlap filter with and without an end field', () => {
    expect(overlapFilter(start, undefined, '2026-10-01', '2026-11-01').children).toHaveLength(2);
    const f = overlapFilter(start, end, '2026-10-01', '2026-11-01');
    expect(JSON.stringify(f)).toContain('"op":"blank"');
  });
});

describe('normalizeForList', () => {
  it('turns single-record Links values into counts for list caches', () => {
    const { patch, stale } = normalizeForList({ a: [{ id: 1, display: 'x' }, { id: 2, display: 'y' }], b: 'text', c: ['tag'] });
    expect(patch).toEqual({ a: 2, b: 'text', c: ['tag'] });
    expect(stale).toBe(false);
    const many = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, display: String(i) }));
    expect(normalizeForList({ a: many }).stale).toBe(true);
  });
});
