import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Base, Column, ListResult, RecordData, Table } from '../../shared/src/index.js';
import { getDb } from '../src/db/index.js';
import { bus } from '../src/events.js';
import { createTestApp, signUpUser } from './helpers.js';

type H = Record<string, string>;
let app: FastifyInstance;
let headers: H;
let userId: string;
let baseId: string;

async function api<T = any>(method: string, url: string, payload?: unknown, status = 200, h: H = headers): Promise<T> {
  const res = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: h, payload: payload as object });
  if (res.statusCode !== status) throw new Error(`${method} ${url} -> ${res.statusCode} (expected ${status}): ${res.body}`);
  return res.json() as T;
}

const col = (t: Table, title: string) => t.columns.find((c) => c.title === title)!;
const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));

beforeAll(async () => {
  app = await createTestApp();
  const u = await signUpUser(app, 'data@example.com');
  headers = u.headers;
  userId = u.userId;
  baseId = (await api<Base>('POST', '/bases', { title: 'Data' })).id;
});

describe('field types', () => {
  it('round-trips every stored field type', async () => {
    const t = await api<Table>('POST', `/bases/${baseId}/tables`, {
      title: 'AllTypes',
      columns: [
        { title: 'Name', type: 'SingleLineText' },
        { title: 'Notes', type: 'LongText' },
        { title: 'Count', type: 'Number' },
        { title: 'Ratio', type: 'Decimal' },
        { title: 'Price', type: 'Currency' },
        { title: 'Pct', type: 'Percent' },
        { title: 'Stars', type: 'Rating', options: { max: 5 } },
        { title: 'Done', type: 'Checkbox' },
        { title: 'Day', type: 'Date' },
        { title: 'At', type: 'DateTime' },
        { title: 'Mail', type: 'Email' },
        { title: 'Site', type: 'URL' },
        { title: 'Phone', type: 'PhoneNumber' },
        { title: 'Status', type: 'SingleSelect', options: { choices: [{ title: 'New' }] } },
        { title: 'Tags', type: 'MultiSelect', options: { choices: [{ title: 'a' }, { title: 'b' }] } },
        { title: 'Files', type: 'Attachment' },
        { title: 'Data', type: 'JSON' },
      ],
    });
    const input = {
      Name: 'Widget',
      Notes: 'line1\nline2',
      Count: '12',
      Ratio: 0.25,
      Price: '$1,234.50',
      Pct: '50%',
      Stars: 9,
      Done: 'yes',
      Day: '2024-02-29',
      At: '2024-03-01T10:20:30Z',
      Mail: 'a@b.co',
      Site: 'https://example.com',
      Phone: '+1 555 0100',
      Status: 'new',
      Tags: 'b, c',
      Files: ['https://example.com/x/photo.png', { url: 'https://example.com/doc.pdf', title: 'Doc', mimetype: 'application/pdf' }],
      Data: { nested: [1, 2] },
    };
    const rec = await api<RecordData>('POST', `/tables/${t.id}/records`, input);
    const v = (title: string) => rec[col(t, title).id];
    expect(rec.id).toBe(1);
    expect(v('Name')).toBe('Widget');
    expect(v('Notes')).toBe('line1\nline2');
    expect(v('Count')).toBe(12);
    expect(v('Ratio')).toBe(0.25);
    expect(v('Price')).toBe(1234.5);
    expect(v('Pct')).toBe(50);
    expect(v('Stars')).toBe(5);
    expect(v('Done')).toBe(true);
    expect(v('Day')).toBe('2024-02-29');
    expect(v('At')).toBe('2024-03-01T10:20:30.000Z');
    expect(v('Mail')).toBe('a@b.co');
    expect(v('Status')).toBe('New');
    expect(v('Tags')).toEqual(['b', 'c']);
    expect(v('Files')).toEqual([
      { url: 'https://example.com/x/photo.png', title: 'photo.png' },
      { url: 'https://example.com/doc.pdf', title: 'Doc', mimetype: 'application/pdf' },
    ]);
    expect(v('Data')).toEqual({ nested: [1, 2] });
    expect(rec[col(t, 'CreatedAt').id]).toMatch(/^\d{4}-/);

    // unknown select option was added to the column's choices
    const tags = await api<Column>('GET', `/columns/${col(t, 'Tags').id}`);
    expect(tags.options.choices!.map((c) => c.title)).toEqual(['a', 'b', 'c']);

    // GET single + list agree
    const got = await api<RecordData>('GET', `/tables/${t.id}/records/${rec.id}`);
    expect(got).toEqual(rec);
    const list = await api<ListResult>('GET', `/tables/${t.id}/records`);
    expect(list.list[0]).toEqual(rec);

    // invalid values are rejected with 400
    await api('POST', `/tables/${t.id}/records`, { Count: 'abc' }, 400);
    await api('POST', `/tables/${t.id}/records`, { Day: 'not a date' }, 400);
    await api('POST', `/tables/${t.id}/records`, { Mail: 'nope' }, 400);

    // update and clear
    const upd = await api<RecordData>('PATCH', `/tables/${t.id}/records/${rec.id}`, { [col(t, 'Count').id]: null, Done: false, Tags: [] });
    expect(upd[col(t, 'Count').id]).toBeNull();
    expect(upd[col(t, 'Done').id]).toBe(false);
    expect(upd[col(t, 'Tags').id]).toBeNull();
    expect(upd[col(t, 'Name').id]).toBe('Widget');
  });

  it('enforces required fields, applies defaults, and lets ids win over titles', async () => {
    const t = await api<Table>('POST', `/bases/${baseId}/tables`, {
      title: 'Req',
      columns: [
        { title: 'Name', type: 'SingleLineText', required: true },
        { title: 'Qty', type: 'Number', defaultValue: 7 },
      ],
    });
    await api('POST', `/tables/${t.id}/records`, { Qty: 1 }, 400);
    const r = await api<RecordData>('POST', `/tables/${t.id}/records`, { Name: 'by title', [col(t, 'Name').id]: 'by id' });
    expect(r[col(t, 'Name').id]).toBe('by id');
    expect(r[col(t, 'Qty').id]).toBe(7);
    await api('PATCH', `/tables/${t.id}/records/${r.id}`, { Name: '' }, 400);
    await api('PATCH', `/tables/${t.id}/records/999`, { Name: 'x' }, 404);
    await api('GET', `/tables/${t.id}/records/999`, undefined, 404);
    // explicit ids are honoured (used by importers), duplicates conflict
    const withId = await api<RecordData>('POST', `/tables/${t.id}/records`, { id: 50, Name: 'fifty' });
    expect(withId.id).toBe(50);
    await api('POST', `/tables/${t.id}/records`, { id: 50, Name: 'again' }, 409);
  });
});

describe('querying', () => {
  let t: Table;
  const c = (title: string) => col(t, title).id;

  beforeAll(async () => {
    t = await api<Table>('POST', `/bases/${baseId}/tables`, {
      title: 'Query',
      columns: [
        { title: 'Name', type: 'SingleLineText' },
        { title: 'Qty', type: 'Number' },
        { title: 'Active', type: 'Checkbox' },
        { title: 'Day', type: 'Date' },
        { title: 'Status', type: 'SingleSelect', options: { choices: [{ title: 'Open' }, { title: 'Closed' }] } },
        { title: 'Tags', type: 'MultiSelect', options: { choices: [{ title: 'x' }, { title: 'y' }, { title: 'z' }] } },
      ],
    });
    const today = new Date();
    const iso = (d: number) => new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);
    await api('POST', `/tables/${t.id}/records`, [
      { Name: 'Apple', Qty: 5, Active: true, Day: iso(-2), Status: 'Open', Tags: ['x'] },
      { Name: 'banana', Qty: 15, Active: false, Day: iso(-40), Status: 'Closed', Tags: ['x', 'y'] },
      { Name: 'Cherry', Qty: 25, Active: true, Day: iso(3), Status: 'Open', Tags: ['y', 'z'] },
      { Name: '', Qty: null, Active: false, Day: null, Status: null, Tags: null },
      { Name: '100% juice', Qty: 0, Active: true, Day: iso(400), Status: 'Closed', Tags: ['z'] },
    ]);
  });

  async function names(filter: unknown, extra = '') {
    const res = await api<ListResult>('GET', `/tables/${t.id}/records?limit=100&filter=${enc(filter)}${extra}`);
    return res.list.map((r) => r[c('Name')]);
  }
  const cond = (title: string, op: string, value?: unknown) => ({ logic: 'and', children: [{ columnId: c(title), op, value }] });

  it('text ops', async () => {
    expect(await names(cond('Name', 'eq', 'apple'))).toEqual(['Apple']);
    expect(await names(cond('Name', 'neq', 'apple'))).toEqual(['banana', 'Cherry', null, '100% juice']);
    expect(await names(cond('Name', 'like', 'an'))).toEqual(['banana']);
    expect(await names(cond('Name', 'like', '%'))).toEqual(['100% juice']);
    expect(await names(cond('Name', 'nlike', 'a'))).toEqual(['Cherry', null, '100% juice']);
    expect(await names(cond('Name', 'blank'))).toEqual([null]);
    expect(await names(cond('Name', 'notblank'))).toHaveLength(4);
    // an empty value means the condition is ignored
    expect(await names(cond('Name', 'eq', ''))).toHaveLength(5);
  });

  it('number, checkbox and select ops', async () => {
    expect(await names(cond('Qty', 'gt', 5))).toEqual(['banana', 'Cherry']);
    expect(await names(cond('Qty', 'gte', '5'))).toEqual(['Apple', 'banana', 'Cherry']);
    expect(await names(cond('Qty', 'lt', 5))).toEqual(['100% juice']);
    expect(await names(cond('Qty', 'lte', 5))).toEqual(['Apple', '100% juice']);
    expect(await names(cond('Qty', 'eq', 15))).toEqual(['banana']);
    expect(await names(cond('Qty', 'neq', 15))).toEqual(['Apple', 'Cherry', null, '100% juice']);
    expect(await names(cond('Qty', 'blank'))).toEqual([null]);
    expect(await names(cond('Active', 'checked'))).toEqual(['Apple', 'Cherry', '100% juice']);
    expect(await names(cond('Active', 'notchecked'))).toEqual(['banana', null]);
    expect(await names(cond('Status', 'eq', 'open'))).toEqual(['Apple', 'Cherry']);
    expect(await names(cond('Status', 'anyof', ['Closed']))).toEqual(['banana', '100% juice']);
    expect(await names(cond('Status', 'nanyof', 'Closed'))).toEqual(['Apple', 'Cherry', null]);
    expect(await names(cond('Status', 'blank'))).toEqual([null]);
  });

  it('multi-select ops', async () => {
    expect(await names(cond('Tags', 'anyof', ['y', 'z']))).toEqual(['banana', 'Cherry', '100% juice']);
    expect(await names(cond('Tags', 'allof', ['x', 'y']))).toEqual(['banana']);
    expect(await names(cond('Tags', 'nanyof', ['x']))).toEqual(['Cherry', null, '100% juice']);
    expect(await names(cond('Tags', 'nallof', ['y', 'z']))).toEqual(['Apple', 'banana', null, '100% juice']);
    expect(await names(cond('Tags', 'blank'))).toEqual([null]);
    expect(await names(cond('Tags', 'notblank'))).toHaveLength(4);
  });

  it('date ops', async () => {
    expect(await names(cond('Day', 'isWithin', 'pastWeek'))).toEqual(['Apple']);
    expect(await names(cond('Day', 'isWithin', 'pastMonth'))).toEqual(['Apple']);
    expect(await names(cond('Day', 'isWithin', 'pastYear'))).toEqual(['Apple', 'banana']);
    expect(await names(cond('Day', 'isWithin', 'nextWeek'))).toEqual(['Cherry']);
    expect(await names(cond('Day', 'isWithin', 'nextYear'))).toEqual(['Cherry']);
    expect(await names(cond('Day', 'gt', 'today'))).toEqual(['Cherry', '100% juice']);
    expect(await names(cond('Day', 'lt', new Date().toISOString().slice(0, 10)))).toEqual(['Apple', 'banana']);
    const d = (await api<ListResult>('GET', `/tables/${t.id}/records`)).list[0][c('Day')] as string;
    expect(await names(cond('Day', 'eq', d))).toEqual(['Apple']);
    expect(await names(cond('Day', 'blank'))).toEqual([null]);
    await api('GET', `/tables/${t.id}/records?filter=${enc(cond('Day', 'isWithin', 'someday'))}`, undefined, 400);
  });

  it('nested AND/OR groups', async () => {
    const f = {
      logic: 'or',
      children: [
        { columnId: c('Name'), op: 'eq', value: 'apple' },
        {
          logic: 'and',
          children: [
            { columnId: c('Status'), op: 'eq', value: 'Closed' },
            { columnId: c('Qty'), op: 'gt', value: 1 },
          ],
        },
      ],
    };
    expect(await names(f)).toEqual(['Apple', 'banana']);
    await api('GET', `/tables/${t.id}/records?filter=${enc({ logic: 'and', children: [{ columnId: 'nope', op: 'eq', value: 1 }] })}`, undefined, 400);
    await api('GET', `/tables/${t.id}/records?filter=notjson`, undefined, 400);
  });

  it('sorts, view filter + sorts, search, fields and pagination', async () => {
    const sorted = await api<ListResult>('GET', `/tables/${t.id}/records?sorts=${enc([{ columnId: c('Qty'), direction: 'desc' }])}`);
    expect(sorted.list.map((r) => r[c('Qty')])).toEqual([25, 15, 5, 0, null]);
    const byName = await api<ListResult>('GET', `/tables/${t.id}/records?sorts=${enc([{ columnId: c('Name'), direction: 'asc' }])}`);
    expect(byName.list.map((r) => r[c('Name')])).toEqual([null, '100% juice', 'Apple', 'banana', 'Cherry']);

    const view = t.views![0];
    await api('PATCH', `/views/${view.id}`, {
      filter: cond('Active', 'checked'),
      sorts: [{ columnId: c('Qty'), direction: 'desc' }],
    });
    const viaView = await api<ListResult>('GET', `/tables/${t.id}/records?viewId=${view.id}`);
    expect(viaView.list.map((r) => r[c('Name')])).toEqual(['Cherry', 'Apple', '100% juice']);
    // query filter is ANDed with the view filter; query sorts override view sorts
    const both = await api<ListResult>(
      'GET',
      `/tables/${t.id}/records?viewId=${view.id}&filter=${enc(cond('Qty', 'gt', 1))}&sorts=${enc([{ columnId: c('Qty'), direction: 'asc' }])}`,
    );
    expect(both.list.map((r) => r[c('Name')])).toEqual(['Apple', 'Cherry']);
    await api('PATCH', `/views/${view.id}`, { filter: null, sorts: [] });

    const search = await api<ListResult>('GET', `/tables/${t.id}/records?search=AN`);
    expect(search.list.map((r) => r[c('Name')])).toEqual(['banana']);
    const searchCol = await api<ListResult>('GET', `/tables/${t.id}/records?search=open&searchColumnId=${c('Status')}`);
    expect(searchCol.list).toHaveLength(2);

    const fields = await api<ListResult>('GET', `/tables/${t.id}/records?fields=${c('Name')},${c('Qty')}&limit=1`);
    expect(Object.keys(fields.list[0]).sort()).toEqual(['id', c('Name'), c('Qty')].sort());

    const p1 = await api<ListResult>('GET', `/tables/${t.id}/records?limit=2`);
    expect(p1.list.map((r) => r.id)).toEqual([1, 2]);
    expect(p1.pageInfo).toEqual({ totalRows: 5, offset: 0, limit: 2, isLastPage: false });
    const p3 = await api<ListResult>('GET', `/tables/${t.id}/records?limit=2&offset=4`);
    expect(p3.list.map((r) => r.id)).toEqual([5]);
    expect(p3.pageInfo.isLastPage).toBe(true);
    const big = await api<ListResult>('GET', `/tables/${t.id}/records?limit=5000`);
    expect(big.pageInfo.limit).toBe(1000);
    const dflt = await api<ListResult>('GET', `/tables/${t.id}/records`);
    expect(dflt.pageInfo.limit).toBe(25);
  });

  it('groups records', async () => {
    const groups = await api<{ value: unknown; count: number }[]>('GET', `/tables/${t.id}/groups?columnId=${c('Status')}`);
    expect(groups).toEqual([
      { value: null, count: 1 },
      { value: 'Open', count: 2 },
      { value: 'Closed', count: 2 },
    ]);
    const filtered = await api('GET', `/tables/${t.id}/groups?columnId=${c('Active')}&filter=${enc(cond('Qty', 'gt', 1))}`);
    expect(filtered).toEqual([
      { value: false, count: 1 },
      { value: true, count: 2 },
    ]);
  });
});

describe('links, lookups and rollups', () => {
  let products: Table;
  let moves: Table;
  let link: Column;
  let back: Column;

  beforeAll(async () => {
    products = await api<Table>('POST', `/bases/${baseId}/tables`, {
      title: 'Products',
      columns: [
        { title: 'Name', type: 'SingleLineText' },
        { title: 'Price', type: 'Currency' },
      ],
    });
    moves = await api<Table>('POST', `/bases/${baseId}/tables`, {
      title: 'Moves',
      columns: [
        { title: 'Ref', type: 'SingleLineText' },
        { title: 'Qty', type: 'Number' },
      ],
    });
    link = await api<Column>('POST', `/tables/${products.id}/columns`, { title: 'Moves', type: 'Links', options: { relatedTableId: moves.id } });
    back = (await api<Table>('GET', `/tables/${moves.id}`)).columns.find((c) => c.type === 'Links')!;
    await api('POST', `/tables/${products.id}/records`, [
      { Name: 'Bolt', Price: 2 },
      { Name: 'Nut', Price: 1 },
    ]);
    await api('POST', `/tables/${moves.id}/records`, [
      { Ref: 'M1', Qty: 10 },
      { Ref: 'M2', Qty: 5 },
      { Ref: 'M3', Qty: -3 },
    ]);
  });

  it('links both directions with counts and details', async () => {
    await api('POST', `/tables/${products.id}/records/1/links/${link.id}`, { ids: [1, 2] });
    // link from the other side
    await api('POST', `/tables/${moves.id}/records/3/links/${back.id}`, { ids: [1] });
    await api('POST', `/tables/${moves.id}/records/3/links/${back.id}`, { ids: [99] }, 400);
    await api('POST', `/tables/${moves.id}/records/3/links/${link.id}`, { ids: [1] }, 404);

    const list = await api<ListResult>('GET', `/tables/${products.id}/records`);
    expect(list.list.map((r) => r[link.id])).toEqual([3, 0]);
    const rec = await api<RecordData>('GET', `/tables/${products.id}/records/1`);
    expect(rec[link.id]).toEqual([
      { id: 1, display: 'M1' },
      { id: 2, display: 'M2' },
      { id: 3, display: 'M3' },
    ]);
    const m3 = await api<RecordData>('GET', `/tables/${moves.id}/records/3`);
    expect(m3[back.id]).toEqual([{ id: 1, display: 'Bolt' }]);

    const linked = await api<ListResult>('GET', `/tables/${products.id}/records/1/links/${link.id}?limit=2`);
    expect(linked.list.map((r) => r.id)).toEqual([1, 2]);
    expect(linked.pageInfo.totalRows).toBe(3);
    const notLinked = await api<ListResult>('GET', `/tables/${products.id}/records/2/links/${link.id}?notLinked=true&search=M2`);
    expect(notLinked.list.map((r) => r.id)).toEqual([2]);

    // filters on Links counts
    const has = await api<ListResult>('GET', `/tables/${products.id}/records?filter=${enc({ logic: 'and', children: [{ columnId: link.id, op: 'notblank' }] })}`);
    expect(has.list.map((r) => r.id)).toEqual([1]);

    // unlink
    await api('DELETE', `/tables/${products.id}/records/1/links/${link.id}`, { ids: [2] });
    const after = await api<RecordData>('GET', `/tables/${products.id}/records/1`);
    expect((after[link.id] as unknown[]).length).toBe(2);
    // setting links through a record update replaces the set
    const upd = await api<RecordData>('PATCH', `/tables/${products.id}/records/2`, { Moves: [2] });
    expect(upd[link.id]).toEqual([{ id: 2, display: 'M2' }]);
    // inserting with links
    const created = await api<RecordData>('POST', `/tables/${moves.id}/records`, { Ref: 'M4', Qty: 1, [back.id]: [2] });
    expect(created[back.id]).toEqual([{ id: 2, display: 'Nut' }]);
  });

  it('lookups and rollups, filterable and sortable', async () => {
    const lookup = await api<Column>('POST', `/tables/${products.id}/columns`, {
      title: 'Refs',
      type: 'Lookup',
      options: { linkColumnId: link.id, targetColumnId: col(moves, 'Ref').id },
    });
    const sum = await api<Column>('POST', `/tables/${products.id}/columns`, {
      title: 'On hand',
      type: 'Rollup',
      options: { linkColumnId: link.id, targetColumnId: col(moves, 'Qty').id, rollupFunction: 'sum' },
    });
    const count = await api<Column>('POST', `/tables/${products.id}/columns`, {
      title: 'Moves count',
      type: 'Rollup',
      options: { linkColumnId: link.id, rollupFunction: 'count' },
    });
    const avg = await api<Column>('POST', `/tables/${products.id}/columns`, {
      title: 'Avg',
      type: 'Rollup',
      options: { linkColumnId: link.id, targetColumnId: col(moves, 'Qty').id, rollupFunction: 'avg' },
    });
    const list = await api<ListResult>('GET', `/tables/${products.id}/records`);
    const [bolt, nut] = list.list;
    expect(bolt[lookup.id]).toEqual(['M1', 'M3']);
    expect(nut[lookup.id]).toEqual(['M2', 'M4']);
    expect(bolt[sum.id]).toBe(7);
    expect(nut[sum.id]).toBe(6);
    expect(bolt[count.id]).toBe(2);
    expect(bolt[avg.id]).toBe(3.5);

    const f = (columnId: string, op: string, value?: unknown) => enc({ logic: 'and', children: [{ columnId, op, value }] });
    let r = await api<ListResult>('GET', `/tables/${products.id}/records?filter=${f(lookup.id, 'eq', 'm3')}`);
    expect(r.list.map((x) => x.id)).toEqual([1]);
    r = await api<ListResult>('GET', `/tables/${products.id}/records?filter=${f(lookup.id, 'like', '4')}`);
    expect(r.list.map((x) => x.id)).toEqual([2]);
    r = await api<ListResult>('GET', `/tables/${products.id}/records?filter=${f(sum.id, 'lt', 7)}`);
    expect(r.list.map((x) => x.id)).toEqual([2]);
    r = await api<ListResult>('GET', `/tables/${products.id}/records?sorts=${enc([{ columnId: sum.id, direction: 'asc' }])}`);
    expect(r.list.map((x) => x.id)).toEqual([2, 1]);
    // search covers lookups
    r = await api<ListResult>('GET', `/tables/${products.id}/records?search=M4`);
    expect(r.list.map((x) => x.id)).toEqual([2]);

    // nested lookup: lookup of a lookup through the back link
    const nested = await api<Column>('POST', `/tables/${moves.id}/columns`, {
      title: 'Product refs',
      type: 'Lookup',
      options: { linkColumnId: back.id, targetColumnId: lookup.id },
    });
    const m1 = await api<RecordData>('GET', `/tables/${moves.id}/records/1`);
    expect(m1[nested.id]).toEqual(['M1', 'M3']);

    // deleting a linked record removes its junction rows
    await api('DELETE', `/tables/${moves.id}/records/3`);
    const bolt2 = await api<RecordData>('GET', `/tables/${products.id}/records/1`);
    expect(bolt2[sum.id]).toBe(10);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM l_${link.id} WHERE b_id = 3`).get()).toEqual({ n: 0 });
  });

  it('bt/hm relations allow one parent', async () => {
    const parents = await api<Table>('POST', `/bases/${baseId}/tables`, { title: 'Parents' });
    const kids = await api<Table>('POST', `/bases/${baseId}/tables`, { title: 'Kids' });
    const bt = await api<Column>('POST', `/tables/${kids.id}/columns`, { title: 'Parent', type: 'Links', options: { relatedTableId: parents.id, relation: 'bt' } });
    const hm = (await api<Table>('GET', `/tables/${parents.id}`)).columns.find((c) => c.type === 'Links')!;
    expect(hm.options.relation).toBe('hm');
    await api('POST', `/tables/${parents.id}/records`, [{ Title: 'P1' }, { Title: 'P2' }]);
    await api('POST', `/tables/${kids.id}/records`, [{ Title: 'K1' }]);
    await api('POST', `/tables/${kids.id}/records/1/links/${bt.id}`, { ids: [1, 2] }, 400);
    await api('POST', `/tables/${kids.id}/records/1/links/${bt.id}`, { ids: [1] });
    await api('POST', `/tables/${kids.id}/records/1/links/${bt.id}`, { ids: [2] });
    expect((await api<RecordData>('GET', `/tables/${kids.id}/records/1`))[bt.id]).toEqual([{ id: 2, display: 'P2' }]);
    // via the hm side: linking K1 to P1 moves it away from P2
    await api('POST', `/tables/${parents.id}/records/1/links/${hm.id}`, { ids: [1] });
    expect((await api<RecordData>('GET', `/tables/${kids.id}/records/1`))[bt.id]).toEqual([{ id: 1, display: 'P1' }]);
  });
});

describe('events', () => {
  const seen: { name: string; args: unknown[] }[] = [];
  const names = ['record.insert', 'record.update', 'record.delete', 'record.link'] as const;
  const listeners = names.map((name) => {
    const fn = (...args: unknown[]) => seen.push({ name, args });
    return [name, fn] as const;
  });
  afterEach(() => {
    for (const [name, fn] of listeners) bus.off(name, fn as never);
  });

  it('emits record events after writes', async () => {
    for (const [name, fn] of listeners) bus.on(name, fn as never);
    const t = await api<Table>('POST', `/bases/${baseId}/tables`, { title: 'Evented' });
    const other = await api<Table>('POST', `/bases/${baseId}/tables`, { title: 'Evented2' });
    const l = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'L', type: 'Links', options: { relatedTableId: other.id } });
    await api('POST', `/tables/${other.id}/records`, { Title: 'o' });
    seen.length = 0;
    const r = await api<RecordData>('POST', `/tables/${t.id}/records`, { Title: 'a' });
    await api('PATCH', `/tables/${t.id}/records/${r.id}`, { Title: 'b' });
    await api('POST', `/tables/${t.id}/records/${r.id}/links/${l.id}`, { ids: [1] });
    await api('DELETE', `/tables/${t.id}/records`, { ids: [r.id] });
    expect(seen.map((s) => s.name)).toEqual(['record.insert', 'record.update', 'record.link', 'record.delete']);
    const [ctx, recs] = seen[0].args as [any, RecordData[]];
    expect(ctx).toEqual({ baseId, tableId: t.id, userId });
    expect(recs[0].id).toBe(r.id);
    const [, changes] = seen[1].args as [any, { before: RecordData; after: RecordData }[]];
    const titleId = col(t, 'Title').id;
    expect(changes[0].before[titleId]).toBe('a');
    expect(changes[0].after[titleId]).toBe('b');
    expect((seen[2].args[0] as any)).toMatchObject({ columnId: l.id, recordId: r.id, linkedIds: [1], unlink: false });
    // failed writes emit nothing
    seen.length = 0;
    await api('POST', `/tables/${t.id}/records`, [{ Title: 'ok' }, { id: 'bad' }], 400);
    expect(seen).toEqual([]);
    expect((await api<ListResult>('GET', `/tables/${t.id}/records`)).pageInfo.totalRows).toBe(0);
  });
});
