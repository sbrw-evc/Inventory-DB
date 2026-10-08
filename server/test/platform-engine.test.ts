/**
 * Platform features that need the real data engine (meta/service.ts + data/records.ts).
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { Column, Table, View } from '../../shared/src/index.js';
import { getRecord, insertRecords, listRecords, updateRecords } from '../src/data/records.js';
import { createBase, createTable, getTable, updateView } from '../src/meta/service.js';
import { flushWebhooks } from '../src/platform/webhooks.js';
import { createTestApp, signUpUser } from './helpers.js';
import { multipart, startReceiver } from './platform-fixtures.js';

const col = (t: Table, title: string): Column => t.columns.find((c) => c.title === title)!;

async function setup() {
  const app = await createTestApp();
  const owner = await signUpUser(app);
  const base = createBase(owner.userId, { title: 'B' });
  const table = createTable(base.id, {
    title: 'Items',
    columns: [
      { title: 'Name', type: 'SingleLineText', primary: true },
      { title: 'Qty', type: 'Number' },
      { title: 'Secret', type: 'SingleLineText' },
      { title: 'Tags', type: 'MultiSelect', options: { choices: [] } },
    ] as never,
  });
  const grid = table.views![0];
  return { app, owner, base, table, grid };
}

describe('platform with data engine', () => {
  it('imports CSV into a new table and into an existing one', async () => {
    const { app, owner, base, table } = await setup();
    const csv = 'Name,Qty,Kind\n' + Array.from({ length: 1200 }, (_, i) => `Item ${i},${i},${i % 2 ? 'A' : 'B'}`).join('\n');
    const mp = multipart({ tableTitle: 'Imported items' }, { name: 'items.csv', content: csv, type: 'text/csv' });
    const res = await app.inject({ method: 'POST', url: `/api/v1/bases/${base.id}/import`, headers: { ...owner.headers, ...mp.headers }, payload: mp.payload });
    expect(res.statusCode).toBe(200);
    const { table: created, inserted } = res.json();
    expect(inserted).toBe(1200);
    expect(created.title).toBe('Imported items');
    expect(col(created, 'Qty').type).toBe('Number');
    expect(col(created, 'Kind').type).toBe('SingleSelect');
    expect(col(created, 'Name').primary).toBe(true);
    expect(listRecords(created.id, { limit: 1 }).pageInfo.totalRows).toBe(1200);

    // existing table: title match (case-insensitive) + explicit columnMap
    const csv2 = 'name,Amount,Ignored\nBolt,4,x\n';
    const mp2 = multipart(
      { tableId: table.id, columnMap: JSON.stringify({ Amount: col(table, 'Qty').id, name: col(table, 'Name').id }) },
      { name: 'more.csv', content: csv2 },
    );
    const res2 = await app.inject({ method: 'POST', url: `/api/v1/bases/${base.id}/import`, headers: { ...owner.headers, ...mp2.headers }, payload: mp2.payload });
    expect(res2.json()).toMatchObject({ inserted: 1, skippedHeaders: ['Ignored'] });
    const [row] = listRecords(table.id, {}).list;
    expect(row[col(table, 'Name').id]).toBe('Bolt');
    expect(row[col(table, 'Qty').id]).toBe(4);

    const log = await app.inject({ method: 'GET', url: `/api/v1/bases/${base.id}/audit`, headers: owner.headers });
    expect(log.json().list.filter((e: { action: string }) => e.action === 'import')).toHaveLength(2);
  });

  it('imports XLSX and JSON', async () => {
    const { app, owner, base } = await setup();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Stock');
    ws.addRow(['Name', 'Price']);
    ws.addRow(['A', 1.5]);
    ws.addRow(['B', 2.25]);
    const mp = multipart({}, { name: 'stock.xlsx', content: Buffer.from(await wb.xlsx.writeBuffer()) });
    const res = await app.inject({ method: 'POST', url: `/api/v1/bases/${base.id}/import`, headers: { ...owner.headers, ...mp.headers }, payload: mp.payload });
    expect(res.json().table.title).toBe('Stock');
    expect(col(res.json().table, 'Price').type).toBe('Decimal');

    const mpj = multipart({}, { name: 'people.json', content: JSON.stringify([{ Name: 'X', Email: 'x@y.com' }]) });
    const resj = await app.inject({ method: 'POST', url: `/api/v1/bases/${base.id}/import`, headers: { ...owner.headers, ...mpj.headers }, payload: mpj.payload });
    expect(resj.json()).toMatchObject({ inserted: 1, table: { title: 'people' } });
  });

  it('exports a view as CSV and XLSX respecting hidden fields', async () => {
    const { app, owner, table, grid } = await setup();
    insertRecords(
      table.id,
      Array.from({ length: 1500 }, (_, i) => ({ [col(table, 'Name').id]: `N${i}`, [col(table, 'Qty').id]: i, [col(table, 'Tags').id]: i === 0 ? ['x', 'y'] : [] })),
      { userId: owner.userId },
    );
    updateView(grid.id, {
      columns: getTable(table.id).columns.map((c, i) => ({ columnId: c.id, show: c.title !== 'Secret', order: i })),
      sorts: [{ columnId: col(table, 'Qty').id, direction: 'asc' }],
    } as Partial<View>);
    const res = await app.inject({ method: 'GET', url: `/api/v1/views/${grid.id}/export?format=csv`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain(encodeURIComponent(`Items - ${grid.title}.csv`));
    const lines = res.body.replace(/^﻿/, '').trim().split(/\r\n/);
    expect(lines).toHaveLength(1501);
    expect(lines[0]).not.toContain('Secret');
    expect(lines[0]).toContain('Name');
    expect(lines[1]).toContain('"x, y"');

    const x = await app.inject({ method: 'GET', url: `/api/v1/views/${grid.id}/export?format=xlsx`, headers: owner.headers });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets[0].rowCount).toBe(1501);
  });

  it('serves public views and shared forms', async () => {
    const { app, owner, table, grid } = await setup();
    insertRecords(table.id, [{ [col(table, 'Name').id]: 'Visible', [col(table, 'Secret').id]: 'hidden!' }], { userId: owner.userId });
    updateView(grid.id, {
      columns: table.columns.map((c, i) => ({ columnId: c.id, show: c.title !== 'Secret', order: i })),
    } as Partial<View>);
    const { shareUuid } = (await app.inject({ method: 'POST', url: `/api/v1/views/${grid.id}/share`, headers: owner.headers, payload: {} })).json();
    const meta = (await app.inject({ method: 'GET', url: `/api/v1/public/views/${shareUuid}` })).json();
    expect(meta.table.columns.map((c: Column) => c.title)).not.toContain('Secret');
    const recs = (await app.inject({ method: 'GET', url: `/api/v1/public/views/${shareUuid}/records` })).json();
    expect(recs.list[0][col(table, 'Name').id]).toBe('Visible');
    expect(JSON.stringify(recs)).not.toContain('hidden!');
    const probe = await app.inject({
      method: 'GET',
      url: `/api/v1/public/views/${shareUuid}/records?filter=${encodeURIComponent(JSON.stringify({ logic: 'and', children: [{ columnId: col(table, 'Secret').id, op: 'eq', value: 'hidden!' }] }))}`,
    });
    expect(probe.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/v1/public/views/${shareUuid}/submit`, payload: {} })).statusCode).toBe(400);

    // form view
    const form = (await import('../src/meta/service.js')).createView(table.id, { title: 'Form', type: 'form' });
    updateView(form.id, {
      columns: table.columns.map((c, i) => ({ columnId: c.id, show: ['Name', 'Qty'].includes(c.title), order: i, required: c.title === 'Qty' })),
    } as Partial<View>);
    const f = (await app.inject({ method: 'POST', url: `/api/v1/views/${form.id}/share`, headers: owner.headers, payload: { password: 'pw' } })).json();
    const noPw = await app.inject({ method: 'POST', url: `/api/v1/public/views/${f.shareUuid}/submit`, payload: { Name: 'x' } });
    expect(noPw.statusCode).toBe(401);
    const missing = await app.inject({ method: 'POST', url: `/api/v1/public/views/${f.shareUuid}/submit`, headers: { 'xc-password': 'pw' }, payload: { Name: 'x' } });
    expect(missing.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/public/views/${f.shareUuid}/submit`,
      headers: { 'xc-password': 'pw' },
      payload: { Name: 'From form', [col(table, 'Qty').id]: 3, Secret: 'ignored' },
    });
    expect(ok.statusCode).toBe(200);
    const saved = getRecord(table.id, ok.json().id);
    expect(saved[col(table, 'Name').id]).toBe('From form');
    expect(saved[col(table, 'Secret').id] ?? null).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/api/v1/public/views/${f.shareUuid}/records`, headers: { 'xc-password': 'pw' } })).statusCode).toBe(404);
  });

  it('audits and fires webhooks for real record writes', async () => {
    const { app, owner, table } = await setup();
    const rx = await startReceiver();
    await app.inject({ method: 'POST', url: `/api/v1/tables/${table.id}/hooks`, headers: owner.headers, payload: { title: 'u', event: 'after.update', url: rx.url } });
    const [r] = insertRecords(table.id, [{ [col(table, 'Name').id]: 'A', [col(table, 'Qty').id]: 1 }], { userId: owner.userId });
    updateRecords(table.id, [{ id: r.id, [col(table, 'Qty').id]: 2 }], { userId: owner.userId });
    await flushWebhooks();
    await rx.close();
    expect(rx.received[0].body).toMatchObject({ data: { rows: [{ Qty: 2 }], previous_rows: [{ Qty: 1 }] } });
    const hist = (await app.inject({ method: 'GET', url: `/api/v1/tables/${table.id}/records/${r.id}/audit`, headers: owner.headers })).json();
    expect(hist.map((e: { action: string }) => e.action)).toEqual(['update', 'insert']);
    expect(hist[0].details).toEqual({ [col(table, 'Qty').id]: { from: 1, to: 2 } });
  });

  it('creates the inventory template with working rollups and formulas', async () => {
    const app = await createTestApp();
    const u = await signUpUser(app);
    const res = await app.inject({ method: 'POST', url: '/api/v1/bases/templates/inventory', headers: u.headers });
    expect(res.statusCode).toBe(200);
    const base = res.json();
    expect(base.title).toBe('Inventory');
    const titles = base.tables.map((t: Table) => t.title).sort();
    expect(titles).toEqual(['Products', 'Stock Movements', 'Suppliers', 'Warehouses']);
    const products: Table = base.tables.find((t: Table) => t.title === 'Products');
    for (const t of ['Supplier', 'Movements', 'On Hand', 'Stock Value', 'Low Stock']) expect(col(products, t)).toBeDefined();
    expect(products.views!.map((v) => v.type).sort()).toEqual(['gallery', 'grid', 'grid', 'kanban']);
    const rows = listRecords(products.id, { limit: 100 }).list;
    expect(rows).toHaveLength(10);
    const cable = rows.find((r) => r[col(products, 'Name').id] === 'USB-C Cable 1m')!;
    expect(cable[col(products, 'On Hand').id]).toBe(75);
    expect(cable[col(products, 'Stock Value').id]).toBeCloseTo(75 * 6.5);
    const low = products.views!.find((v) => v.title === 'Low stock')!;
    const lowRows = listRecords(products.id, { viewId: low.id, limit: 100 }).list;
    expect(lowRows.every((r) => r[col(products, 'Low Stock').id] === 'Yes')).toBe(true);
    const moves: Table = base.tables.find((t: Table) => t.title === 'Stock Movements');
    expect(listRecords(moves.id, { limit: 100 }).pageInfo.totalRows).toBe(20);
    expect(moves.views!.map((v) => v.type).sort()).toEqual(['calendar', 'form', 'grid']);
  });
});
