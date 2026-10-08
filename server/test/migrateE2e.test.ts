/**
 * End-to-end: mock NocoDB → runMigration → our real data engine. Enabled with WITH_DATA_ENGINE=1 once the data
 * engine and jobs modules are merged (they're stubs in the migration worktree).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Column, Table } from '../../shared/src/index.js';
import { getRecord, listRecords } from '../src/data/records.js';
import { getBase, getTable } from '../src/meta/service.js';
import { runMigration } from '../src/migrate/nocodbMigration.js';
import { createJob, getJob } from '../src/platform/jobs.js';
import { createTestApp, signUpUser } from './helpers.js';
import { MOCK_TOKEN, startMockNocoDB, type MockNocoDB } from './migrateNocodbMock.js';

describe.skipIf(!process.env.WITH_DATA_ENGINE)('NocoDB migration end-to-end (real data engine)', () => {
  let mock: MockNocoDB;
  beforeAll(async () => {
    mock = await startMockNocoDB();
  });
  afterAll(async () => mock?.close());

  it('migrates the Products/Suppliers base', async () => {
    const app = await createTestApp();
    const { userId } = await signUpUser(app);
    const job = createJob(userId, 'nocodb-migration');
    const result = await runMigration({ url: mock.url, token: MOCK_TOKEN, nocoBaseId: 'pinv0001', userId, jobId: job.id, client: { retryBaseMs: 1 } });
    const finished = getJob(job.id);
    expect(finished.status, `${finished.message}\n${finished.log.join('\n')}`).toBe('done');
    expect(result).toMatchObject({ tables: 2, records: 5 });
    expect(JSON.stringify(finished)).not.toContain(MOCK_TOKEN);

    const base = getBase(result!.baseId);
    expect(base.title).toBe('Inventory');
    expect(base.tables.map((t) => t.title).sort()).toEqual(['Products', 'Suppliers']);
    const products = getTable(base.tables.find((t) => t.title === 'Products')!.id);
    const suppliers = getTable(base.tables.find((t) => t.title === 'Suppliers')!.id);
    const col = (t: Table, title: string): Column => {
      const c = t.columns.find((x) => x.title === title);
      if (!c) throw new Error(`missing ${t.title}.${title}: ${t.columns.map((x) => x.title).join(', ')}`);
      return c;
    };

    // Schema
    expect(col(products, 'Title').primary).toBe(true);
    for (const [title, type] of [
      ['Price', 'Decimal'],
      ['Category', 'SingleSelect'],
      ['Tags', 'MultiSelect'],
      ['InStock', 'Checkbox'],
      ['Photo', 'Attachment'],
      ['Quantity', 'Number'],
      ['Supplier', 'Links'],
      ['Supplier Name', 'Lookup'],
      ['Total', 'Formula'],
    ] as const) {
      expect(col(products, title).type, title).toBe(type);
    }
    expect(col(suppliers, 'Products').type).toBe('Links');
    expect(col(suppliers, 'Product Count').type).toBe('Rollup');
    expect(col(suppliers, 'Owner').type).toBe('SingleLineText');
    expect(col(products, 'Supplier').options.symmetricColumnId).toBe(col(suppliers, 'Products').id);

    // Records
    const all = listRecords(products.id, { limit: 100 }).list;
    expect(all).toHaveLength(3);
    const widget = all.find((r) => r[col(products, 'Title').id] === 'Widget')!;
    expect(widget[col(products, 'Price').id]).toBe(9.5);
    expect(widget[col(products, 'Tags').id]).toEqual(['new', 'sale']);
    expect(widget[col(products, 'InStock').id]).toBe(true);
    expect(widget[col(products, 'Category').id]).toBe('Hardware');
    expect((widget[col(products, 'Photo').id] as { url: string }[])[0]!.url).toBe('https://cdn.example.com/nc/uploads/widget.png');
    expect(Number(widget[col(products, 'Total').id])).toBe(95);
    expect(widget[col(products, 'Supplier Name').id]).toEqual(['Acme']);

    const acme = listRecords(suppliers.id, { limit: 100 }).list.find((r) => r[col(suppliers, 'Name').id] === 'Acme')!;
    expect(Number(acme[col(suppliers, 'Product Count').id])).toBe(2);
    const linked = getRecord(suppliers.id, acme.id)[col(suppliers, 'Products').id] as { display: unknown }[];
    expect(linked.map((l) => l.display).sort()).toEqual(['Gadget', 'Widget']);

    // Views
    const views = products.views ?? [];
    expect(views.map((v) => `${v.title}:${v.type}`)).toEqual(expect.arrayContaining(['In stock:grid', 'By category:kanban']));
    const inStock = views.find((v) => v.title === 'In stock')!;
    expect(inStock.locked).toBe(true);
    expect(inStock.sorts[0]).toEqual({ columnId: col(products, 'Price').id, direction: 'desc' });
    const filtered = listRecords(products.id, { viewId: inStock.id, limit: 100 }).list.map((r) => r[col(products, 'Title').id]);
    expect(filtered).toEqual(['Gizmo', 'Widget']);
    const kanban = views.find((v) => v.title === 'By category')!;
    expect(kanban.meta.groupColumnId).toBe(col(products, 'Category').id);
    const form = (suppliers.views ?? []).find((v) => v.type === 'form')!;
    expect(form.meta.formHeading).toBe('Add a supplier');
  });
});
