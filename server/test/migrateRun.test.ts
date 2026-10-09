/**
 * Runs the whole migration against the mock NocoDB with an in-memory fake of the data engine and jobs store, so
 * the orchestration (ordering, id maps, link pairing, views, report, token hygiene) is tested independently of
 * the real engine. The same scenario against the real engine lives in migrateE2e.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Column, ColumnOptions, FieldType, Job, Table, View, ViewType } from '../../shared/src/index.js';
import { MOCK_TOKEN, startMockNocoDB, type MockNocoDB } from './migrateNocodbMock.js';

interface FakeState {
  bases: { id: string; title: string; owner: string }[];
  tables: Table[];
  views: View[];
  rows: Map<string, Record<string, unknown>[]>;
  links: { columnId: string; recordId: number; ids: number[] }[];
  jobs: Map<string, Job>;
  rejectFormulas: boolean;
  seq: number;
}

const fake = vi.hoisted(() => ({ s: null as unknown as FakeState }));

vi.mock('../src/meta/service.js', () => {
  const s = () => fake.s;
  const id = (p: string) => `${p}${++s().seq}`;
  const table = (tableId: string) => {
    const t = s().tables.find((x) => x.id === tableId);
    if (!t) throw new Error(`no table ${tableId}`);
    return t;
  };
  const col = (tableId: string, input: { title: string; type: FieldType; options?: ColumnOptions; primary?: boolean }): Column => {
    const t = table(tableId);
    if (t.columns.some((c) => c.title.toLowerCase() === input.title.toLowerCase())) throw new Error(`duplicate title ${input.title}`);
    const c: Column = {
      id: id('col'),
      tableId,
      title: input.title,
      type: input.type,
      primary: !!input.primary,
      required: false,
      options: { ...(input.options ?? {}) },
      order: t.columns.length,
    };
    t.columns.push(c);
    for (const v of s().views.filter((x) => x.tableId === tableId)) v.columns.push({ columnId: c.id, show: true, order: v.columns.length });
    return c;
  };
  const view = (tableId: string, title: string, type: ViewType): View => {
    const v: View = {
      id: id('vw'),
      tableId,
      title,
      type,
      order: 0,
      locked: false,
      filter: null,
      sorts: [],
      columns: table(tableId).columns.map((c, i) => ({ columnId: c.id, show: true, order: i })),
      meta: {},
    };
    s().views.push(v);
    return v;
  };
  return {
    createBase: (userId: string, input: { title: string }) => {
      const b = { id: id('base'), title: input.title, owner: userId };
      s().bases.push(b);
      return { id: b.id, title: b.title, order: 0, createdAt: '', role: 'owner' };
    },
    deleteBase: (baseId: string) => {
      s().bases = s().bases.filter((b) => b.id !== baseId);
    },
    createTable: (baseId: string, input: { title: string; columns?: { title: string; type: FieldType; primary?: boolean; options?: ColumnOptions }[] }) => {
      const t: Table = { id: id('tbl'), baseId, title: input.title, order: 0, columns: [] };
      s().tables.push(t);
      s().rows.set(t.id, []);
      col(t.id, { title: 'Id', type: 'ID' });
      for (const c of input.columns ?? []) col(t.id, c);
      if (!t.columns.some((c) => c.primary)) col(t.id, { title: 'Title', type: 'SingleLineText', primary: true });
      col(t.id, { title: 'Created', type: 'CreatedTime' });
      col(t.id, { title: 'Modified', type: 'LastModifiedTime' });
      view(t.id, input.title, 'grid');
      return { ...t, views: s().views.filter((v) => v.tableId === t.id) };
    },
    getTable: (tableId: string) => ({ ...table(tableId), views: s().views.filter((v) => v.tableId === tableId) }),
    addColumn: (tableId: string, input: { title: string; type: FieldType; options?: ColumnOptions }) => {
      if (input.type === 'Formula') {
        const titles = new Set(table(tableId).columns.map((c) => c.title));
        const refs = [...(input.options?.formula ?? '').matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!);
        if (s().rejectFormulas || refs.some((r) => !titles.has(r))) throw new Error('Invalid formula');
      }
      if (input.type === 'Lookup' || input.type === 'Rollup') {
        const all = s().tables.flatMap((t) => t.columns);
        if (!all.some((c) => c.id === input.options?.linkColumnId && c.type === 'Links')) throw new Error('bad link column');
        if (!all.some((c) => c.id === input.options?.targetColumnId)) throw new Error('bad target');
      }
      const c = col(tableId, input);
      if (input.type === 'Links') {
        const rel = input.options!.relation!;
        const sym = col(input.options!.relatedTableId!, {
          title: table(tableId).title,
          type: 'Links',
          options: { relatedTableId: tableId, relation: rel === 'hm' ? 'bt' : rel === 'bt' ? 'hm' : 'mm', symmetricColumnId: c.id },
        });
        c.options.symmetricColumnId = sym.id;
      }
      return c;
    },
    updateColumn: (columnId: string, patch: { title?: string }) => {
      const c = s().tables.flatMap((t) => t.columns).find((x) => x.id === columnId)!;
      if (patch.title) c.title = patch.title;
      return c;
    },
    createView: (tableId: string, input: { title: string; type: ViewType }) => view(tableId, input.title, input.type),
    getView: (viewId: string) => s().views.find((v) => v.id === viewId)!,
    updateView: (viewId: string, patch: Partial<View>) => {
      const v = s().views.find((x) => x.id === viewId)!;
      Object.assign(v, patch);
      return v;
    },
  };
});

vi.mock('../src/data/records.js', () => ({
  insertRecords: (tableId: string, rows: Record<string, unknown>[]) => {
    const store = fake.s.rows.get(tableId)!;
    return rows.map((r) => {
      const rec = { id: store.length + 1, ...r };
      store.push(rec);
      return rec;
    });
  },
  linkRecords: (columnId: string, recordId: number, ids: number[]) => {
    fake.s.links.push({ columnId, recordId, ids });
  },
}));

vi.mock('../src/platform/jobs.js', () => ({
  createJob: (_userId: string, kind: Job['kind']): Job => {
    const job: Job = { id: `job${++fake.s.seq}`, kind, status: 'queued', progress: 0, message: '', log: [], createdAt: '' };
    fake.s.jobs.set(job.id, job);
    return job;
  },
  updateJob: (jobId: string, patch: { status?: Job['status']; progress?: number; message?: string; appendLog?: string; result?: unknown }) => {
    const job = fake.s.jobs.get(jobId)!;
    const { appendLog, ...rest } = patch;
    Object.assign(job, rest);
    if (appendLog) job.log.push(appendLog);
    return job;
  },
  getJob: (jobId: string) => fake.s.jobs.get(jobId)!,
}));

const { runMigration } = await import('../src/migrate/nocodbMigration.js');
const { createJob } = await import('../src/platform/jobs.js');

let mock: MockNocoDB;
beforeEach(async () => {
  fake.s = { bases: [], tables: [], views: [], rows: new Map(), links: [], jobs: new Map(), rejectFormulas: false, seq: 0 };
  mock = await startMockNocoDB();
});
afterEach(async () => mock.close());

const tableByTitle = (title: string) => fake.s.tables.find((t) => t.title === title)!;
const colByTitle = (t: Table, title: string) => t.columns.find((c) => c.title === title)!;

describe('runMigration (fake engine)', () => {
  it('copies schema, records, links and views and reports skipped items', async () => {
    const job = createJob('u1', 'nocodb-migration');
    const result = await runMigration({ url: mock.url, token: MOCK_TOKEN, nocoBaseId: 'pinv0001', userId: 'u1', jobId: job.id, client: { retryBaseMs: 1 } });
    const finished = fake.s.jobs.get(job.id)!;
    expect(finished.status, finished.message).toBe('done');
    expect(result).toMatchObject({ tables: 2, records: 5, links: 2, views: 6 });
    expect(finished.result).toEqual(result);
    expect(fake.s.bases).toEqual([{ id: result!.baseId, title: 'Inventory', owner: 'u1' }]);
    expect(fake.s.tables.map((t) => t.title)).toEqual(['Products', 'Suppliers']);

    // Schema
    const products = tableByTitle('Products');
    const suppliers = tableByTitle('Suppliers');
    expect(products.columns.map((c) => `${c.title}:${c.type}`)).toEqual([
      'Id:ID',
      'Title:SingleLineText',
      'Created:CreatedTime',
      'Modified:LastModifiedTime',
      'Price:Decimal',
      'Category:SingleSelect',
      'Tags:MultiSelect',
      'InStock:Checkbox',
      'Photo:Attachment',
      'Quantity:Number',
      'Supplier:Links',
      'Total:Formula',
      'Supplier Name:Lookup',
    ]);
    expect(colByTitle(products, 'Title').primary).toBe(true);
    expect(colByTitle(products, 'Category').options.choices?.map((c) => c.title)).toEqual(['Hardware', 'Software']);
    expect(colByTitle(products, 'Total').options.formula).toBe('{Price} * {Quantity}');
    expect(suppliers.columns.map((c) => `${c.title}:${c.type}`)).toEqual([
      'Id:ID',
      'Name:SingleLineText',
      'Created:CreatedTime',
      'Modified:LastModifiedTime',
      'Since:Date',
      'Owner:SingleLineText',
      'Products:Links',
      'Product Count:Rollup',
    ]);
    // Created once from the has-many side; the belongs-to side is our symmetric column, renamed to NocoDB's title.
    const link = colByTitle(suppliers, 'Products');
    expect(link.options).toMatchObject({ relation: 'hm', relatedTableId: products.id });
    expect(colByTitle(products, 'Supplier').id).toBe(link.options.symmetricColumnId);
    expect(colByTitle(products, 'Supplier Name').options).toEqual({ linkColumnId: link.options.symmetricColumnId, targetColumnId: colByTitle(suppliers, 'Name').id });
    expect(colByTitle(suppliers, 'Product Count').options).toEqual({
      linkColumnId: link.id,
      targetColumnId: colByTitle(products, 'Title').id,
      rollupFunction: 'count',
    });

    // Records
    const prow = fake.s.rows.get(products.id)!;
    const c = (t: string) => colByTitle(products, t).id;
    expect(prow[0]).toEqual({
      id: 1,
      [c('Title')]: 'Widget',
      [c('Price')]: 9.5,
      [c('Category')]: 'Hardware',
      [c('Tags')]: ['new', 'sale'],
      [c('InStock')]: true,
      [c('Photo')]: [{ url: 'https://cdn.example.com/nc/uploads/widget.png', title: 'widget.png', mimetype: 'image/png', size: 1234 }],
      [c('Quantity')]: 10,
    });
    expect(prow[2]![c('Photo')]).toEqual([{ url: `${mock.url}/download/noco/inventory/Products/Photo/gizmo.jpg`, title: 'gizmo.jpg', mimetype: 'image/jpeg', size: 2048 }]);
    expect(fake.s.rows.get(suppliers.id)![0]).toMatchObject({ [colByTitle(suppliers, 'Owner').id]: 'Alice', [colByTitle(suppliers, 'Since').id]: '2023-05-01' });

    // Links: Acme (our 1) has Widget (1) and Gadget (2); Globex has none and was not fetched.
    expect(fake.s.links).toEqual([{ columnId: link.id, recordId: 1, ids: [1, 2] }]);
    const linkCalls = mock.requests.filter((r) => r.path.includes('/links/'));
    expect(linkCalls.map((r) => r.path)).toEqual(['/api/v2/tables/mdsupp02/links/clsprd03/records/1']);

    // Views
    const pviews = fake.s.views.filter((v) => v.tableId === products.id);
    expect(pviews.map((v) => `${v.title}:${v.type}`)).toEqual(['Products:grid', 'In stock:grid', 'By category:kanban', 'Warehouses map:map']);
    const inStock = pviews[1]!;
    expect(inStock.locked).toBe(true);
    expect(inStock.filter).toEqual({
      logic: 'and',
      children: [
        { columnId: c('InStock'), op: 'checked' },
        {
          logic: 'or',
          children: [
            { columnId: c('Price'), op: 'gt', value: 5 },
            { columnId: c('Tags'), op: 'anyof', value: ['sale', 'eco'] },
          ],
        },
      ],
    });
    expect(inStock.sorts).toEqual([
      { columnId: c('Price'), direction: 'desc' },
      { columnId: c('Title'), direction: 'asc' },
    ]);
    expect(inStock.meta.groupBy).toEqual([{ columnId: c('Category'), direction: 'desc' }]);
    const vc = (id: string) => inStock.columns.find((x) => x.columnId === id)!;
    expect(vc(c('Title'))).toMatchObject({ show: true, width: 240, order: 0 });
    expect(vc(c('Photo')).show).toBe(false);
    expect(vc(c('InStock')).show).toBe(false);
    expect(vc(c('Price')).order).toBeLessThan(vc(c('Quantity')).order);
    const kanban = pviews[2]!;
    expect(kanban.meta).toMatchObject({ groupColumnId: c('Category'), coverColumnId: c('Photo'), stackOrder: ['Software', 'Hardware'] });

    const sviews = fake.s.views.filter((v) => v.tableId === suppliers.id);
    const form = sviews.find((v) => v.type === 'form')!;
    expect(form.meta).toMatchObject({ formHeading: 'Add a supplier', formSubheading: 'We will get back to you', formSubmitMessage: 'Thanks for submitting!' });
    expect(form.columns.find((x) => x.columnId === colByTitle(suppliers, 'Name').id)).toMatchObject({
      label: 'Company name',
      help: 'Legal name of the company',
      required: true,
      show: true,
    });
    expect(form.columns.find((x) => x.columnId === colByTitle(suppliers, 'Owner').id)?.show).toBe(false);

    // Report
    expect(result!.skipped).toEqual(
      expect.arrayContaining([
        'low_stock_sql_view: database view is not migrated',
        'Products.Barcode: Barcode fields are not supported',
        'Products / view "In stock": filter relative date comparison "today"',
        'Products / view "Warehouses map": map location field was not migrated',
      ]),
    );
    expect(result!.converted).toEqual(['Suppliers.Owner: User converted to text (user names/emails)']);

    // The token never reaches the job.
    expect(JSON.stringify(finished)).not.toContain(MOCK_TOKEN);
    expect(finished.log.some((l) => l.includes(mock.url))).toBe(true);
  });

  it('falls back to a text column with the computed values when the formula is rejected', async () => {
    fake.s.rejectFormulas = true;
    const job = createJob('u1', 'nocodb-migration');
    const result = await runMigration({ url: mock.url, token: MOCK_TOKEN, nocoBaseId: 'pinv0001', targetTitle: 'Copy', userId: 'u1', jobId: job.id });
    expect(fake.s.jobs.get(job.id)!.status).toBe('done');
    expect(fake.s.bases[0]!.title).toBe('Copy');
    const products = tableByTitle('Products');
    const total = colByTitle(products, 'Total');
    expect(total.type).toBe('LongText');
    expect(fake.s.rows.get(products.id)!.map((r) => r[total.id])).toEqual(['95', '12.75', '0']);
    expect(result!.converted.some((n) => n.startsWith('Products.Total: formula kept as text'))).toBe(true);
  });

  it('fails the job with a clear message and removes the partial base', async () => {
    const job = createJob('u1', 'nocodb-migration');
    const result = await runMigration({ url: mock.url, token: 'bad-token-xyz', nocoBaseId: 'pinv0001', userId: 'u1', jobId: job.id });
    expect(result).toBeNull();
    const j = fake.s.jobs.get(job.id)!;
    expect(j.status).toBe('failed');
    expect(j.message).toBe('Invalid NocoDB API token');
    expect(JSON.stringify(j)).not.toContain('bad-token-xyz');

    const job2 = createJob('u1', 'nocodb-migration');
    await runMigration({ url: mock.url, token: MOCK_TOKEN, nocoBaseId: 'missing', userId: 'u1', jobId: job2.id });
    expect(fake.s.jobs.get(job2.id)!.status).toBe('failed');
    expect(fake.s.bases).toEqual([]);
  });
});
