/**
 * Behaviour that depends on how the app maps its loosely typed values onto PostgreSQL: sequences after explicit ids,
 * numeric filters on integer columns, mixed-type formulas, JSON-valued fields, NULL ordering and transactions.
 */
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Base, Column, ListResult, RecordData, Table } from '../../shared/src/index.js';
import { getDb } from '../src/db/index.js';
import { createTestApp, openTestDb, signUpUser } from './helpers.js';

let app: FastifyInstance;
let headers: Record<string, string>;
let baseId: string;

async function api<T = any>(method: string, url: string, payload?: unknown, status = 200): Promise<T> {
  const res = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers, payload: payload as object });
  if (res.statusCode !== status) throw new Error(`${method} ${url} -> ${res.statusCode} (expected ${status}): ${res.body}`);
  return res.json() as T;
}
const col = (t: Table, title: string) => t.columns.find((c) => c.title === title)!;
const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));
const where = (columnId: string, op: string, value?: unknown) => enc({ logic: 'and', children: [{ columnId, op, value }] });

beforeAll(async () => {
  app = await createTestApp();
  headers = (await signUpUser(app, 'Mixed.Case@Example.com')).headers;
  baseId = (await api<Base>('POST', '/bases', { title: 'PG' })).id;
});

describe('postgres storage', () => {
  it('signs in with any letter case of the email and rejects a duplicate that differs only in case', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signin', payload: { email: 'mixed.case@example.com', password: 'password123' } });
    expect(res.statusCode).toBe(200);
    const dup = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { email: 'MIXED.case@example.com', password: 'password123' } });
    expect(dup.statusCode).toBe(409);
  });

  it('continues the id sequence after records inserted with explicit ids', async () => {
    const t = await api<Table>('POST', `/bases/${baseId}/tables`, { title: 'Ids', columns: [{ title: 'Name', type: 'SingleLineText' }] });
    await api('POST', `/tables/${t.id}/records`, [{ id: 10, Name: 'ten' }]);
    const next = await api<RecordData>('POST', `/tables/${t.id}/records`, { Name: 'next' });
    expect(next.id).toBe(11);
  });

  it('filters integer columns with fractional values and sorts empty values first', async () => {
    const t = await api<Table>('POST', `/bases/${baseId}/tables`, {
      title: 'Nums',
      columns: [
        { title: 'Name', type: 'SingleLineText' },
        { title: 'Qty', type: 'Number' },
      ],
    });
    await api('POST', `/tables/${t.id}/records`, [{ Name: 'b', Qty: 2 }, { Name: 'none' }, { Name: 'A', Qty: 1 }]);
    const qty = col(t, 'Qty').id;
    const gt = await api<ListResult>('GET', `/tables/${t.id}/records?filter=${where(qty, 'gt', 1.5)}`);
    expect(gt.list.map((r) => r.id)).toEqual([1]);
    const eq = await api<ListResult>('GET', `/tables/${t.id}/records?filter=${where(qty, 'eq', '1.5')}`);
    expect(eq.list).toEqual([]);
    const asc = await api<ListResult>('GET', `/tables/${t.id}/records?sorts=${enc([{ columnId: qty, direction: 'asc' }])}`);
    expect(asc.list.map((r) => r.id)).toEqual([2, 3, 1]);
    const desc = await api<ListResult>('GET', `/tables/${t.id}/records?sorts=${enc([{ columnId: qty, direction: 'desc' }])}`);
    expect(desc.list.map((r) => r.id)).toEqual([1, 3, 2]);
    // text sorts ignore case
    const byName = await api<ListResult>('GET', `/tables/${t.id}/records?sorts=${enc([{ columnId: col(t, 'Name').id, direction: 'asc' }])}`);
    expect(byName.list.map((r) => r.id)).toEqual([3, 1, 2]);
    const groups = await api<{ value: unknown; count: number }[]>('GET', `/tables/${t.id}/groups?columnId=${qty}`);
    expect(groups).toEqual([
      { value: null, count: 1 },
      { value: 1, count: 1 },
      { value: 2, count: 1 },
    ]);
  });

  it('evaluates formulas that mix text, numbers, checkboxes and dates', async () => {
    const t = await api<Table>('POST', `/bases/${baseId}/tables`, {
      title: 'Mixed',
      columns: [
        { title: 'Code', type: 'SingleLineText' },
        { title: 'Qty', type: 'Number' },
        { title: 'Done', type: 'Checkbox' },
        { title: 'At', type: 'DateTime' },
      ],
    });
    await api('POST', `/tables/${t.id}/records`, [
      { Code: '7', Qty: 3, Done: true, At: '2024-01-31T10:00:00.000Z' },
      { Code: 'x', Qty: 0, Done: false },
    ]);
    const add = async (title: string, formula: string) => (await api<Column>('POST', `/tables/${t.id}/columns`, { title, type: 'Formula', options: { formula } })).id;
    const f = {
      mixedIf: await add('MixedIf', 'IF({Qty} > 1, {Qty}, "none")'),
      flag: await add('Flag', 'IF({Done}, "yes", "no")'),
      textMath: await add('TextMath', '{Code} + {Qty}'),
      cmp: await add('Cmp', '{Code} = 7'),
      later: await add('Later', 'DATEADD({At}, 1, "month")'),
      concat: await add('Concat', '{Code} & "-" & {Qty} & "-" & {Done}'),
      sqrt: await add('Sqrt', 'SQRT(-{Qty})'),
    };
    const [a, b] = (await api<ListResult>('GET', `/tables/${t.id}/records`)).list;
    expect([a[f.mixedIf], b[f.mixedIf]]).toEqual(['3', 'none']);
    expect([a[f.flag], b[f.flag]]).toEqual(['yes', 'no']);
    expect([a[f.textMath], b[f.textMath]]).toEqual([10, null]);
    expect([a[f.cmp], b[f.cmp]]).toEqual([1, null]);
    expect([a[f.later], b[f.later]]).toEqual(['2024-02-29T10:00:00.000Z', null]);
    expect([a[f.concat], b[f.concat]]).toEqual(['7-3-1', 'x-0-0']);
    expect([a[f.sqrt], b[f.sqrt]]).toEqual([null, 0]);
    // filters on formula results of either type
    const byFlag = await api<ListResult>('GET', `/tables/${t.id}/records?filter=${where(f.flag, 'eq', 'YES')}`);
    expect(byFlag.list.map((r) => r.id)).toEqual([1]);
    const byCmp = await api<ListResult>('GET', `/tables/${t.id}/records?filter=${where(f.cmp, 'eq', 1)}`);
    expect(byCmp.list.map((r) => r.id)).toEqual([1]);
    const byDate = await api<ListResult>('GET', `/tables/${t.id}/records?filter=${where(col(t, 'At').id, 'gt', '2024-01-01')}`);
    expect(byDate.list.map((r) => r.id)).toEqual([1]);
  });

  it('renames multi-select choices in stored data and filters on them', async () => {
    const t = await api<Table>('POST', `/bases/${baseId}/tables`, {
      title: 'Tagged',
      columns: [{ title: 'Tags', type: 'MultiSelect', options: { choices: [{ title: 'red' }, { title: 'blue' }] } }],
    });
    await api('POST', `/tables/${t.id}/records`, [{ Tags: ['red', 'blue'] }, { Tags: ['blue'] }, {}]);
    const tags = col(t, 'Tags');
    const choices = tags.options.choices!.map((c) => (c.title === 'red' ? { ...c, title: 'crimson' } : c));
    await api('PATCH', `/columns/${tags.id}`, { options: { choices } });
    const list = await api<ListResult>('GET', `/tables/${t.id}/records`);
    expect(list.list.map((r) => r[tags.id])).toEqual([['crimson', 'blue'], ['blue'], null]);
    const exact = await api<ListResult>('GET', `/tables/${t.id}/records?filter=${where(tags.id, 'eq', ['blue'])}`);
    expect(exact.list.map((r) => r.id)).toEqual([2]);
    const any = await api<ListResult>('GET', `/tables/${t.id}/records?filter=${where(tags.id, 'anyof', 'CRIMSON')}`);
    expect(any.list.map((r) => r.id)).toEqual([1]);
    const blank = await api<ListResult>('GET', `/tables/${t.id}/records?filter=${where(tags.id, 'blank')}`);
    expect(blank.list.map((r) => r.id)).toEqual([3]);
  });

  it('rolls back a failed request completely, including DDL', async () => {
    const tableCount = async () => (await api<{ tables: Table[] }>('GET', `/bases/${baseId}`)).tables.length;
    const before = await tableCount();
    // the second column is invalid, so the table (created in the same transaction) must not exist afterwards
    await api('POST', `/bases/${baseId}/tables`, { title: 'Broken', columns: [{ title: 'Ok', type: 'Number' }, { title: 'Bad', type: 'Formula', options: { formula: '{Nope}' } }] }, 400);
    expect(await tableCount()).toBe(before);
    const leftovers = getDb()
      .prepare("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 't\\_%'")
      .get() as { n: number };
    expect(leftovers.n).toBe(before);
  });

  it('nests transactions with savepoints', () => {
    const db = openTestDb();
    db.exec('CREATE TABLE tx_probe (v INTEGER)');
    db.transaction(() => {
      db.prepare('INSERT INTO tx_probe (v) VALUES (?)').run(1);
      expect(() =>
        db.transaction(() => {
          db.prepare('INSERT INTO tx_probe (v) VALUES (?)').run(2);
          throw new Error('inner');
        })(),
      ).toThrow('inner');
      db.prepare('INSERT INTO tx_probe (v) VALUES (?)').run(3);
    })();
    expect((db.prepare('SELECT v FROM tx_probe ORDER BY v').all() as { v: number }[]).map((r) => r.v)).toEqual([1, 3]);
    db.close();
  });
});
