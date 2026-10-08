import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Base, Column, Table, View } from '../../shared/src/index.js';
import { getDb } from '../src/db/index.js';
import { createTestApp, signUpUser } from './helpers.js';

type H = Record<string, string>;
let app: FastifyInstance;
let owner: H;
let ownerId: string;

function call(headers: H) {
  return async <T = any>(method: string, url: string, payload?: unknown, status = 200): Promise<T> => {
    const res = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers, payload: payload as object });
    if (res.statusCode !== status) throw new Error(`${method} ${url} -> ${res.statusCode} (expected ${status}): ${res.body}`);
    return res.json() as T;
  };
}

const physicalColumns = (tableId: string) =>
  (getDb().prepare(`SELECT name FROM pragma_table_info(?)`).all(`t_${tableId}`) as { name: string }[]).map((r) => r.name);
const tableExists = (name: string) => !!getDb().prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

beforeAll(async () => {
  app = await createTestApp();
  const u = await signUpUser(app, 'meta-owner@example.com');
  owner = u.headers;
  ownerId = u.userId;
});

describe('bases', () => {
  it('CRUD with roles; non-members get 404, viewers cannot write', async () => {
    const api = call(owner);
    const base = await api<Base>('POST', '/bases', { title: 'Inventory', color: '#f00' });
    expect(base.role).toBe('owner');
    expect((await api<Base[]>('GET', '/bases')).map((b) => b.id)).toContain(base.id);
    const got = await api<Base & { tables: Table[] }>('GET', `/bases/${base.id}`);
    expect(got.tables).toEqual([]);
    expect(got.role).toBe('owner');
    const upd = await api<Base>('PATCH', `/bases/${base.id}`, { title: 'Stock' });
    expect(upd.title).toBe('Stock');

    const stranger = await signUpUser(app);
    const s = call(stranger.headers);
    await s('GET', `/bases/${base.id}`, undefined, 404);
    expect(await s<Base[]>('GET', '/bases')).toEqual([]);

    const viewer = await signUpUser(app);
    getDb().prepare(`INSERT INTO nc_base_members (base_id, user_id, role) VALUES (?, ?, 'viewer')`).run(base.id, viewer.userId);
    const v = call(viewer.headers);
    await v('GET', `/bases/${base.id}`);
    await v('POST', `/bases/${base.id}/tables`, { title: 'X' }, 403);
    await v('PATCH', `/bases/${base.id}`, { title: 'nope' }, 403);

    const editor = await signUpUser(app);
    getDb().prepare(`INSERT INTO nc_base_members (base_id, user_id, role) VALUES (?, ?, 'editor')`).run(base.id, editor.userId);
    const t = await call(editor.headers)<Table>('POST', `/bases/${base.id}/tables`, { title: 'Things' });
    await call(editor.headers)('DELETE', `/bases/${base.id}`, undefined, 403);
    await v('GET', `/tables/${t.id}`);
    await s('GET', `/tables/${t.id}`, undefined, 404);
    await v('POST', `/tables/${t.id}/records`, {}, 403);

    await api('DELETE', `/bases/${base.id}`);
    expect(tableExists(`t_${t.id}`)).toBe(false);
    await api('GET', `/bases/${base.id}`, undefined, 404);
    await call({})('GET', '/bases', undefined, 401);
    expect(ownerId).toBeTruthy();
  });
});

describe('tables and columns', () => {
  let baseId: string;
  beforeAll(async () => {
    baseId = (await call(owner)<Base>('POST', '/bases', { title: 'B' })).id;
  });

  it('creates a table with system columns, a primary Title and a default grid view', async () => {
    const api = call(owner);
    const t = await api<Table>('POST', `/bases/${baseId}/tables`, { title: 'Products' });
    const types = t.columns.map((c) => c.type);
    expect(types).toEqual(['ID', 'SingleLineText', 'CreatedTime', 'LastModifiedTime']);
    const title = t.columns[1];
    expect(title.title).toBe('Title');
    expect(title.primary).toBe(true);
    expect(t.columns[0].system).toBe(true);
    expect(t.views).toHaveLength(1);
    const view = t.views![0];
    expect(view.title).toBe('Default view');
    expect(view.type).toBe('grid');
    expect(view.columns.find((c) => c.columnId === t.columns[2].id)!.show).toBe(false);
    expect(view.columns.find((c) => c.columnId === title.id)!.show).toBe(true);
    expect(physicalColumns(t.id)).toEqual(['id', 'created_at', 'updated_at', 'created_by', `c_${title.id}`]);

    await api('POST', `/bases/${baseId}/tables`, { title: 'products' }, 400);
    const renamed = await api<Table>('PATCH', `/tables/${t.id}`, { title: 'Items', description: 'd' });
    expect(renamed.title).toBe('Items');
  });

  it('creates a table from column definitions and picks the first text column as primary', async () => {
    const api = call(owner);
    const t = await api<Table>('POST', `/bases/${baseId}/tables`, {
      title: 'Suppliers',
      columns: [
        { title: 'Name', type: 'SingleLineText' },
        { title: 'Rating', type: 'Rating', options: { max: 3 } },
        { title: 'Status', type: 'SingleSelect', options: { choices: [{ title: 'Active', color: '#0f0' }, { title: 'Inactive' }] } },
      ],
    });
    expect(t.columns.map((c) => c.title)).toEqual(['ID', 'Name', 'Rating', 'Status', 'CreatedAt', 'UpdatedAt']);
    expect(t.columns.find((c) => c.title === 'Name')!.primary).toBe(true);
    const status = t.columns.find((c) => c.title === 'Status')!;
    expect(status.options.choices!.map((c) => c.title)).toEqual(['Active', 'Inactive']);
    expect(status.options.choices![1].color).toMatch(/^#/);
    expect(status.options.choices![0].id).toBeTruthy();
  });

  it('adds, renames, validates and deletes columns; views follow', async () => {
    const api = call(owner);
    const t = await api<Table>('POST', `/bases/${baseId}/tables`, { title: 'ColTest' });
    const col = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'Qty', type: 'Number' });
    expect(physicalColumns(t.id)).toContain(`c_${col.id}`);
    const view = await api<View>('GET', `/views/${t.views![0].id}`);
    expect(view.columns.at(-1)).toMatchObject({ columnId: col.id, show: true });

    await api('POST', `/tables/${t.id}/columns`, { title: 'qty', type: 'Number' }, 400);
    await api('POST', `/tables/${t.id}/columns`, { title: 'Bad', type: 'Nope' }, 400);
    await api('POST', `/tables/${t.id}/columns`, { title: 'Id2', type: 'ID' }, 400);

    const renamed = await api<Column>('PATCH', `/columns/${col.id}`, { title: 'Quantity', description: 'How many' });
    expect(renamed.title).toBe('Quantity');

    // filter/sort referencing the column is removed with it
    await api('PATCH', `/views/${view.id}`, {
      filter: { logic: 'and', children: [{ columnId: col.id, op: 'gt', value: 1 }] },
      sorts: [{ columnId: col.id, direction: 'desc' }],
    });
    await api('DELETE', `/columns/${col.id}`);
    expect(physicalColumns(t.id)).not.toContain(`c_${col.id}`);
    const after = await api<View>('GET', `/views/${view.id}`);
    expect(after.columns.some((c) => c.columnId === col.id)).toBe(false);
    expect(after.filter!.children).toEqual([]);
    expect(after.sorts).toEqual([]);

    // system and primary columns cannot be deleted
    await api('DELETE', `/columns/${t.columns[0].id}`, undefined, 400);
    await api('DELETE', `/columns/${t.columns[1].id}`, undefined, 400);
    // switch primary, then the old primary can be deleted
    const other = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'Code', type: 'SingleLineText', primary: true });
    expect(other.primary).toBe(true);
    const t2 = await api<Table>('GET', `/tables/${t.id}`);
    expect(t2.columns.filter((c) => c.primary).map((c) => c.id)).toEqual([other.id]);
    await api('DELETE', `/columns/${t.columns[1].id}`);
    await api('PATCH', `/columns/${other.id}`, { primary: false }, 400);
  });

  it('converts column types best-effort', async () => {
    const api = call(owner);
    const t = await api<Table>('POST', `/bases/${baseId}/tables`, { title: 'Convert' });
    const c = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'Val', type: 'SingleLineText' });
    await api('POST', `/tables/${t.id}/records`, [{ [c.id]: '42' }, { [c.id]: 'abc' }, { [c.id]: '3.7' }, { [c.id]: 'red, blue' }]);
    await api('PATCH', `/columns/${c.id}`, { type: 'Number' });
    let list = (await api('GET', `/tables/${t.id}/records`)).list;
    expect(list.map((r: any) => r[c.id])).toEqual([42, null, 4, null]);

    await api('PATCH', `/columns/${c.id}`, { type: 'SingleLineText' });
    list = (await api('GET', `/tables/${t.id}/records`)).list;
    expect(list.map((r: any) => r[c.id])).toEqual(['42', null, '4', null]);

    const tags = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'Tags', type: 'LongText' });
    await api('PATCH', `/tables/${t.id}/records`, [{ id: list[0].id, [tags.id]: 'red, blue' }, { id: list[1].id, [tags.id]: 'blue' }]);
    const conv = await api<Column>('PATCH', `/columns/${tags.id}`, { type: 'MultiSelect' });
    expect(conv.options.choices!.map((x) => x.title).sort()).toEqual(['blue', 'red']);
    list = (await api('GET', `/tables/${t.id}/records`)).list;
    expect(list[0][tags.id]).toEqual(['red', 'blue']);
    expect(list[1][tags.id]).toEqual(['blue']);

    // MultiSelect -> SingleSelect keeps the first option
    await api('PATCH', `/columns/${tags.id}`, { type: 'SingleSelect' });
    list = (await api('GET', `/tables/${t.id}/records`)).list;
    expect(list[0][tags.id]).toBe('red');

    // select choice rename (matched by id) renames stored values
    const sel = await api<Column>('GET', `/columns/${tags.id}`);
    const choices = sel.options.choices!.map((ch) => (ch.title === 'red' ? { ...ch, title: 'crimson' } : ch));
    await api('PATCH', `/columns/${tags.id}`, { options: { choices } });
    list = (await api('GET', `/tables/${t.id}/records`)).list;
    expect(list[0][tags.id]).toBe('crimson');

    // to a formula and back: formula values are materialised
    const f = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'F', type: 'Formula', options: { formula: '{Val} & "!"' } });
    await api('PATCH', `/columns/${f.id}`, { type: 'SingleLineText' });
    list = (await api('GET', `/tables/${t.id}/records`)).list;
    expect(list[0][f.id]).toBe('42!');
    expect(physicalColumns(t.id)).toContain(`c_${f.id}`);
    await api('PATCH', `/columns/${f.id}`, { type: 'Formula', options: { formula: 'LEN({Val})' } });
    expect(physicalColumns(t.id)).not.toContain(`c_${f.id}`);
    list = (await api('GET', `/tables/${t.id}/records`)).list;
    expect(list[0][f.id]).toBe(2);

    // system fields cannot change type
    await api('PATCH', `/columns/${t.columns[0].id}`, { type: 'Number' }, 400);
  });

  it('links create a symmetric column; deleting cleans up junctions, lookups and the other side', async () => {
    const api = call(owner);
    const a = await api<Table>('POST', `/bases/${baseId}/tables`, { title: 'Orders' });
    const b = await api<Table>('POST', `/bases/${baseId}/tables`, { title: 'Customers' });
    const link = await api<Column>('POST', `/tables/${a.id}/columns`, { title: 'Customer', type: 'Links', options: { relatedTableId: b.id } });
    expect(link.options.relation).toBe('mm');
    expect((link.options as any)._jt).toBeUndefined();
    const b2 = await api<Table>('GET', `/tables/${b.id}`);
    const sym = b2.columns.find((c) => c.type === 'Links')!;
    expect(sym.title).toBe('Orders');
    expect(sym.options.symmetricColumnId).toBe(link.id);
    expect(link.options.symmetricColumnId).toBe(sym.id);
    expect(b2.views![0].columns.some((c) => c.columnId === sym.id)).toBe(true);
    expect(tableExists(`l_${link.id}`)).toBe(true);

    const lookup = await api<Column>('POST', `/tables/${a.id}/columns`, {
      title: 'Customer name',
      type: 'Lookup',
      options: { linkColumnId: link.id, targetColumnId: b.columns[1].id },
    });
    await api('POST', `/tables/${a.id}/columns`, { title: 'Bad lookup', type: 'Lookup', options: { linkColumnId: b.columns[1].id } }, 400);

    // deleting the symmetric side removes both sides and the dependent lookup
    await api('DELETE', `/columns/${sym.id}`);
    const a2 = await api<Table>('GET', `/tables/${a.id}`);
    expect(a2.columns.some((c) => c.id === link.id || c.id === lookup.id)).toBe(false);
    expect(tableExists(`l_${link.id}`)).toBe(false);

    // deleting a table removes Links columns pointing at it
    const link2 = await api<Column>('POST', `/tables/${a.id}/columns`, { title: 'Customer', type: 'Links', options: { relatedTableId: b.id } });
    await api('DELETE', `/tables/${b.id}`);
    const a3 = await api<Table>('GET', `/tables/${a.id}`);
    expect(a3.columns.some((c) => c.id === link2.id)).toBe(false);
    expect(tableExists(`l_${link2.id}`)).toBe(false);
    expect(tableExists(`t_${b.id}`)).toBe(false);
    await api('GET', `/tables/${b.id}`, undefined, 404);
  });

  it('rejects links to tables in another base', async () => {
    const api = call(owner);
    const other = await api<Base>('POST', '/bases', { title: 'Other' });
    const ot = await api<Table>('POST', `/bases/${other.id}/tables`, { title: 'T' });
    const t = await api<Table>('POST', `/bases/${baseId}/tables`, { title: 'Local' });
    await api('POST', `/tables/${t.id}/columns`, { title: 'L', type: 'Links', options: { relatedTableId: ot.id } }, 400);
  });
});

describe('views', () => {
  it('creates, copies, updates, locks and deletes views', async () => {
    const api = call(owner);
    const base = await api<Base>('POST', '/bases', { title: 'Views' });
    const t = await api<Table>('POST', `/bases/${base.id}/tables`, {
      title: 'Tasks',
      columns: [
        { title: 'Name', type: 'SingleLineText' },
        { title: 'Stage', type: 'SingleSelect', options: { choices: [{ title: 'Todo' }, { title: 'Done' }] } },
        { title: 'Due', type: 'Date' },
      ],
    });
    const stage = t.columns.find((c) => c.title === 'Stage')!;
    const due = t.columns.find((c) => c.title === 'Due')!;
    const kanban = await api<View>('POST', `/tables/${t.id}/views`, { title: 'Board', type: 'kanban' });
    expect(kanban.meta.groupColumnId).toBe(stage.id);
    const cal = await api<View>('POST', `/tables/${t.id}/views`, { title: 'Calendar', type: 'calendar' });
    expect(cal.meta.dateColumnId).toBe(due.id);
    await api('POST', `/tables/${t.id}/views`, { title: 'board', type: 'grid' }, 400);

    const grid = t.views![0];
    const hidden = grid.columns.map((c) => (c.columnId === due.id ? { ...c, show: false, width: 300 } : c));
    await api('PATCH', `/views/${grid.id}`, {
      columns: hidden,
      sorts: [{ columnId: due.id, direction: 'desc' }],
      filter: { logic: 'and', children: [{ columnId: stage.id, op: 'eq', value: 'Todo' }] },
    });
    await api('PATCH', `/views/${grid.id}`, { sorts: [{ columnId: 'col_nope', direction: 'asc' }] }, 400);
    const copy = await api<View>('POST', `/tables/${t.id}/views`, { title: 'Copy', type: 'grid', copyFromViewId: grid.id });
    expect(copy.columns.find((c) => c.columnId === due.id)).toMatchObject({ show: false, width: 300 });
    expect(copy.sorts).toEqual([{ columnId: due.id, direction: 'desc' }]);
    expect(copy.filter!.children).toHaveLength(1);

    // new columns are appended to every view
    const extra = await api<Column>('POST', `/tables/${t.id}/columns`, { title: 'Notes', type: 'LongText' });
    for (const v of [grid.id, kanban.id, copy.id]) {
      const got = await api<View>('GET', `/views/${v}`);
      expect(got.columns.at(-1)!.columnId).toBe(extra.id);
    }

    // locking: an editor can lock but not change or unlock a locked view
    const editor = await signUpUser(app);
    getDb().prepare(`INSERT INTO nc_base_members (base_id, user_id, role) VALUES (?, ?, 'editor')`).run(base.id, editor.userId);
    const ed = call(editor.headers);
    await ed('PATCH', `/views/${copy.id}`, { locked: true });
    await ed('PATCH', `/views/${copy.id}`, { title: 'Renamed' }, 403);
    await ed('PATCH', `/views/${copy.id}`, { locked: false }, 403);
    await ed('DELETE', `/views/${copy.id}`, undefined, 403);
    await api('PATCH', `/views/${copy.id}`, { title: 'Renamed', locked: false });
    await ed('PATCH', `/views/${copy.id}`, { title: 'Renamed again' });

    await api('DELETE', `/views/${copy.id}`);
    await api('DELETE', `/views/${kanban.id}`);
    await api('DELETE', `/views/${cal.id}`);
    await api('DELETE', `/views/${grid.id}`, undefined, 400);
  });
});
