import { describe, expect, it } from 'vitest';
import type { Column } from '@shared';
import { asStringList, formatValue, fromDateTimeInput, normalizeDate, parseInputValue, toDateInput, toDateTimeInput } from './format';

const col = (type: Column['type'], options: Column['options'] = {}) => ({ type, options });

describe('formatValue', () => {
  it('formats currency with code and precision', () => {
    const s = formatValue(col('Currency', { currencyCode: 'USD', precision: 2 }), 1234.5);
    expect(s).toMatch(/1,234\.50/);
    expect(s).toMatch(/\$/);
  });
  it('formats percent and decimal precision', () => {
    expect(formatValue(col('Percent', { precision: 1 }), 12.345)).toBe('12.3%');
    expect(formatValue(col('Decimal', { precision: 3 }), 2)).toMatch(/2\.000/);
  });
  it('joins multi select and attachments, counts links', () => {
    expect(formatValue(col('MultiSelect'), ['a', 'b'])).toBe('a, b');
    expect(formatValue(col('Attachment'), [{ url: '/x.png', title: 'x.png' }])).toBe('x.png');
    expect(formatValue(col('Links'), 3)).toBe('3 records');
    expect(formatValue(col('Links'), [{ id: 1, display: 'Acme' }])).toBe('Acme');
  });
  it('renders empty for null', () => {
    expect(formatValue(col('SingleLineText'), null)).toBe('');
  });
});

describe('parseInputValue', () => {
  it('parses numbers leniently and rejects garbage', () => {
    expect(parseInputValue(col('Number'), '1,200')).toBe(1200);
    expect(parseInputValue(col('Currency'), '$ 19.90')).toBe(19.9);
    expect(parseInputValue(col('Percent'), '15%')).toBe(15);
    expect(parseInputValue(col('Number'), 'abc')).toBeUndefined();
    expect(parseInputValue(col('Decimal'), '')).toBeNull();
  });
  it('parses checkbox words', () => {
    expect(parseInputValue(col('Checkbox'), 'yes')).toBe(true);
    expect(parseInputValue(col('Checkbox'), 'no')).toBe(false);
  });
  it('splits multi select and parses JSON', () => {
    expect(parseInputValue(col('MultiSelect'), 'a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(parseInputValue(col('MultiSelect'), '["x","y"]')).toEqual(['x', 'y']);
    expect(parseInputValue(col('JSON'), '{"a":1}')).toEqual({ a: 1 });
    expect(parseInputValue(col('JSON'), '{bad')).toBeUndefined();
  });
  it('normalises dates', () => {
    expect(parseInputValue(col('Date'), '2026-03-04')).toBe('2026-03-04');
    expect(normalizeDate('04.03.2026')).toBe('2026-03-04');
    expect(parseInputValue(col('Date'), 'not a date')).toBeUndefined();
  });
});

describe('date inputs', () => {
  it('round-trips datetime-local values', () => {
    const iso = fromDateTimeInput('2026-05-06T07:08')!;
    expect(toDateTimeInput(iso)).toBe('2026-05-06T07:08');
    expect(toDateInput('2026-05-06')).toBe('2026-05-06');
    expect(toDateInput(null)).toBe('');
  });
});

describe('asStringList', () => {
  it('accepts arrays, JSON strings and comma lists', () => {
    expect(asStringList(['a'])).toEqual(['a']);
    expect(asStringList('["a","b"]')).toEqual(['a', 'b']);
    expect(asStringList('a, b')).toEqual(['a', 'b']);
    expect(asStringList(null)).toEqual([]);
  });
});
