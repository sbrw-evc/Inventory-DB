import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Base, Column, ListResult, RecordData, Table } from '../../shared/src/index.js';
import { FormulaError, compileFormula, displayFormula, normalizeFormula, parseFormula } from '../src/data/formula.js';
import { val } from '../src/data/sql.js';
import { createTestApp, signUpUser } from './helpers.js';

const mem = new Database(':memory:');
/** Evaluate a formula with {a}, {b}, {s}, {d} bound to constants. */
function evalF(src: string, refs: Record<string, unknown> = {}) {
  const frag = compileFormula(parseFormula(src), (name) => {
    if (!(name in refs)) throw new FormulaError(`Unknown field {${name}}`);
    return val(refs[name]);
  });
  return (mem.prepare(`SELECT ${frag.sql} AS v`).get(...frag.params) as { v: unknown }).v;
}

describe('formula parser and compiler', () => {
  it('arithmetic, precedence, unary minus and division by zero', () => {
    expect(evalF('1 + 2 * 3')).toBe(7);
    expect(evalF('(1 + 2) * 3')).toBe(9);
    expect(evalF('10 / 4')).toBe(2.5);
    expect(evalF('10 / 0')).toBeNull();
    expect(evalF('7 % 3')).toBe(1);
    expect(evalF('-{a} + 1', { a: 5 })).toBe(-4);
    expect(evalF('2 * -3')).toBe(-6);
    expect(evalF('1.5e2')).toBe(150);
  });

  it('comparisons, logic and strings', () => {
    expect(evalF('1 < 2')).toBe(1);
    expect(evalF('{a} = 3', { a: 3 })).toBe(1);
    expect(evalF('{a} != 3', { a: 3 })).toBe(0);
    expect(evalF('IF({a} >= 10, "big", "small")', { a: 12 })).toBe('big');
    expect(evalF('IF(FALSE, 1)')).toBeNull();
    expect(evalF('AND(1, 0)')).toBe(0);
    expect(evalF('OR(1, 0, 0)')).toBe(1);
    expect(evalF('NOT(TRUE)')).toBe(0);
    expect(evalF('SWITCH({s}, "a", 1, "b", 2, 0)', { s: 'b' })).toBe(2);
    expect(evalF('SWITCH({s}, "a", 1, "b", 2, 0)', { s: 'z' })).toBe(0);
    expect(evalF(`"x" & {s} & 'y'`, { s: null })).toBe('xy');
    expect(evalF('CONCAT("a", 1, {s})', { s: 'c' })).toBe('a1c');
    expect(evalF('UPPER("ab") & LOWER("CD") & TRIM("  e  ")')).toBe('ABcde');
    expect(evalF('LEN("hello")')).toBe(5);
    expect(evalF('LEFT("hello", 2) & RIGHT("hello", 3) & MID("hello", 2, 2)')).toBe('helloel');
    expect(evalF('SUBSTITUTE("a-b-c", "-", "+")')).toBe('a+b+c');
    expect(evalF('REPLACE("a-b", "-", "")')).toBe('ab');
    expect(evalF('"it\\"s"')).toBe('it"s');
  });

  it('math functions', () => {
    expect(evalF('ROUND(2.345, 2)')).toBe(2.35);
    expect(evalF('ROUND(2.5)')).toBe(3);
    expect(evalF('FLOOR(2.7) + CEILING(2.1)')).toBe(5);
    expect(evalF('ABS(-3)')).toBe(3);
    expect(evalF('MIN(3, 1, 2)')).toBe(1);
    expect(evalF('MAX(3, 1, 2)')).toBe(3);
    expect(evalF('MAX(4)')).toBe(4);
    expect(evalF('MOD(10, 3)')).toBe(1);
    expect(evalF('MOD(10, 0)')).toBeNull();
    expect(evalF('POWER(2, 10)')).toBe(1024);
    expect(evalF('SQRT(16)')).toBe(4);
    expect(evalF('VALUE("1,234.5")')).toBe(1234.5);
    expect(evalF('VALUE("abc")')).toBeNull();
    expect(evalF('TEXT(12)')).toBe('12');
    expect(evalF('BLANK()')).toBeNull();
    expect(evalF('ISBLANK({s})', { s: '' })).toBe(1);
    expect(evalF('ISBLANK({s})', { s: 'x' })).toBe(0);
  });

  it('date functions', () => {
    expect(evalF('DATEADD({d}, 3, "day")', { d: '2024-01-30' })).toBe('2024-02-02');
    expect(evalF('DATEADD({d}, 2, "weeks")', { d: '2024-01-01' })).toBe('2024-01-15');
    expect(evalF('DATEADD({d}, 1, "month")', { d: '2024-01-15' })).toBe('2024-02-15');
    expect(evalF('DATEADD({d}, -1, "year")', { d: '2024-01-15' })).toBe('2023-01-15');
    expect(evalF('DATEADD({d}, 1, "day")', { d: '2024-01-01T10:00:00.000Z' })).toBe('2024-01-02T10:00:00.000Z');
    expect(evalF('DATETIME_DIFF({a}, {b}, "days")', { a: '2024-03-01', b: '2024-02-01' })).toBe(29);
    expect(evalF('DATETIME_DIFF({a}, {b}, "hour")', { a: '2024-01-02T00:00:00Z', b: '2024-01-01T12:00:00Z' })).toBe(12);
    expect(evalF('DATETIME_DIFF({a}, {b}, "month")', { a: '2024-05-01', b: '2023-12-31' })).toBe(5);
    expect(evalF('YEAR({d}) * 10000 + MONTH({d}) * 100 + DAY({d})', { d: '2024-07-09' })).toBe(20240709);
    expect(evalF('WEEKDAY({d})', { d: '2024-07-08' })).toBe(0); // Monday
    expect(evalF('WEEKDAY({d})', { d: '2024-07-14' })).toBe(6); // Sunday
    expect(evalF('TODAY()')).toBe(new Date().toISOString().slice(0, 10));
    expect(String(evalF('NOW()'))).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('reports syntax errors, unknown functions and arity', () => {
    expect(() => parseFormula('1 +')).toThrow(/end of formula/);
    expect(() => parseFormula('FOO(1)')).toThrow(/Unknown function FOO/);
    expect(() => parseFormula('IF(1)')).toThrow(/IF expects 2 to 3 arguments/);
    expect(() => parseFormula('{a')).toThrow(/Unclosed field reference/);
    expect(() => parseFormula('"abc')).toThrow(/Unclosed string/);
    expect(() => parseFormula('price * 2')).toThrow(/Unknown identifier/);
    expect(() => parseFormula('1 2')).toThrow(/Unexpected "2"/);
    expect(() => parseFormula('')).toThrow(/empty/);
    expect(() => evalF('DATEADD({d}, 1, "fortnight")', { d: '2024-01-01' })).toThrow(/unknown unit/);
  });

  it('normalises titles to ids and back, keeping formatting', () => {
    const cols = [
      { id: 'col_1', title: 'Unit Price' },
      { id: 'col_2', title: 'Qty {x}' },
    ];
    const { normalized, refs } = normalizeFormula('{unit price}  *  {Qty {x\\}}', cols);
    expect(normalized).toBe('{col_1}  *  {col_2}');
    expect(refs).toEqual(['col_1', 'col_2']);
    expect(displayFormula(normalized, (id) => ({ col_1: 'Price', col_2: 'Qty {x}' })[id])).toBe('{Price}  *  {Qty {x\\}}');
    expect(() => normalizeFormula('{Nope} + 1', cols)).toThrow(/Unknown field \{Nope\}/);
  });
});

describe('formula fields end-to-end', () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;
  async function api<T = any>(method: string, url: string, payload?: unknown, status = 200): Promise<T> {
    const res = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers, payload: payload as object });
    if (res.statusCode !== status) throw new Error(`${method} ${url} -> ${res.statusCode} (expected ${status}): ${res.body}`);
    return res.json() as T;
  }
  let t: Table;
  let total: Column;

  beforeAll(async () => {
    app = await createTestApp();
    headers = (await signUpUser(app)).headers;
    const base = await api<Base>('POST', '/bases', { title: 'F' });
    t = await api<Table>('POST', `/bases/${base.id}/tables`, {
      title: 'Lines',
      columns: [
        { title: 'Item', type: 'SingleLineText' },
        { title: 'Price', type: 'Currency' },
        { title: 'Qty', type: 'Number' },
        { title: 'Min', type: 'Number' },
      ],
    });
    total = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'Total', type: 'Formula', options: { formula: '{Price} * {Qty}' } });
    await api('POST', `/tables/${t.id}/records`, [
      { Item: 'a', Price: 2, Qty: 10, Min: 5 },
      { Item: 'b', Price: 5, Qty: 1, Min: 5 },
      { Item: 'c', Price: 1, Qty: 0, Min: 0 },
    ]);
  });

  it('computes, filters and sorts on formula values', async () => {
    const low = await api<Column>('POST', `/tables/${t.id}/columns`, {
      title: 'Low stock',
      type: 'Formula',
      options: { formula: 'IF({Qty} < {Min}, "LOW", "OK")' },
    });
    const list = await api<ListResult>('GET', `/tables/${t.id}/records`);
    expect(list.list.map((r) => r[total.id])).toEqual([20, 5, 0]);
    expect(list.list.map((r) => r[low.id])).toEqual(['OK', 'LOW', 'OK']);
    const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));
    const filtered = await api<ListResult>('GET', `/tables/${t.id}/records?filter=${enc({ logic: 'and', children: [{ columnId: low.id, op: 'eq', value: 'low' }] })}`);
    expect(filtered.list.map((r) => r.id)).toEqual([2]);
    const gt = await api<ListResult>('GET', `/tables/${t.id}/records?filter=${enc({ logic: 'and', children: [{ columnId: total.id, op: 'gt', value: 1 }] })}`);
    expect(gt.list.map((r) => r.id)).toEqual([1, 2]);
    const sorted = await api<ListResult>('GET', `/tables/${t.id}/records?sorts=${enc([{ columnId: total.id, direction: 'asc' }])}`);
    expect(sorted.list.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it('formula over formula, rename-safe references and display form', async () => {
    const withTax = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'With tax', type: 'Formula', options: { formula: 'ROUND({Total} * 1.2, 2)' } });
    expect(withTax.options.formula).toBe('ROUND({Total} * 1.2, 2)');
    await api('PATCH', `/columns/${total.id}`, { title: 'Line total' });
    const got = await api<Column>('GET', `/columns/${withTax.id}`);
    expect(got.options.formula).toBe('ROUND({Line total} * 1.2, 2)');
    const rec = await api<RecordData>('GET', `/tables/${t.id}/records/1`);
    expect(rec[withTax.id]).toBe(24);
    // unary minus on a field
    const neg = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'Neg', type: 'Formula', options: { formula: '-{Qty}' } });
    expect((await api<RecordData>('GET', `/tables/${t.id}/records/1`))[neg.id]).toBe(-10);
  });

  it('rejects invalid formulas and circular references with 400', async () => {
    const bad = async (formula: string, pattern: RegExp) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tables/${t.id}/columns`,
        headers,
        payload: { title: `Bad ${Math.random()}`, type: 'Formula', options: { formula } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(pattern);
    };
    await bad('{Nope} + 1', /Unknown field \{Nope\}/);
    await bad('FOO({Qty})', /Unknown function FOO/);
    await bad('{Qty} +', /end of formula/);

    const a = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'A', type: 'Formula', options: { formula: '{Qty} + 1' } });
    const b = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'B', type: 'Formula', options: { formula: '{A} * 2' } });
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/columns/${a.id}`, headers, payload: { options: { formula: '{B} + 1' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Circular reference/);
    const self = await app.inject({ method: 'PATCH', url: `/api/v1/columns/${a.id}`, headers, payload: { options: { formula: '{A} + 1' } } });
    expect(self.json().message).toMatch(/Circular reference/);
    expect((await api<RecordData>('GET', `/tables/${t.id}/records/1`))[b.id]).toBe(22);

    // a formula whose field is deleted evaluates to null instead of breaking the table
    const min = t.columns.find((c) => c.title === 'Min')!;
    const usesMin = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'UsesMin', type: 'Formula', options: { formula: '{Min} + 1' } });
    await api('DELETE', `/columns/${min.id}`);
    const rec = await api<RecordData>('GET', `/tables/${t.id}/records/1`);
    expect(rec[usesMin.id]).toBeNull();
    expect(rec[b.id]).toBe(22);
  });
});
