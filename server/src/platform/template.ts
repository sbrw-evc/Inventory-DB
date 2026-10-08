import type { FastifyInstance } from 'fastify';
import type { Base, Column, Table, View, ViewColumn } from '../../../shared/src/index.js';
import { requireUser } from '../auth/plugin.js';
import { insertRecords } from '../data/records.js';
import { getDb } from '../db/index.js';
import { addColumn, createBase, createTable, createView, getBase, getTable, updateColumn, updateView } from '../meta/service.js';
import { audit, withoutRecordAudit } from './audit.js';
import { doc } from './docs.js';
import { choicesFrom } from './infer.js';

type ColumnInput = Parameters<typeof addColumn>[1];

const col = (table: Table, title: string): Column => {
  const c = table.columns.find((x) => x.title === title);
  if (!c) throw new Error(`Template: column "${title}" missing on ${table.title}`);
  return c;
};

/** Full view-column list for `table`, showing only `shown` (in that order) and applying form overrides. */
function viewColumns(table: Table, shown: string[], overrides: Record<string, Partial<ViewColumn>> = {}): ViewColumn[] {
  const order = new Map(shown.map((t, i) => [t, i]));
  return table.columns.map((c) => ({
    columnId: c.id,
    show: order.has(c.title),
    order: order.get(c.title) ?? shown.length + c.order,
    ...(overrides[c.title] ?? {}),
  }));
}

const CATEGORIES = ['Electronics', 'Office', 'Furniture', 'Packaging', 'Tools'];

/** Builds the Inventory starter base for `userId`. Synchronous and transactional. */
export function createInventoryBase(userId: string): Base & { tables: Table[] } {
  const db = getDb();
  return db.transaction(() =>
    withoutRecordAudit(() => {
      const base = createBase(userId, { title: 'Inventory', description: 'Products, suppliers, warehouses and stock movements', color: '#2d7ff9' });

      const text = (title: string, primary = false): ColumnInput => ({ title, type: 'SingleLineText', primary }) as ColumnInput;
      const suppliers = createTable(base.id, {
        title: 'Suppliers',
        columns: [text('Name', true), text('Contact'), { title: 'Email', type: 'Email' } as ColumnInput, { title: 'Phone', type: 'PhoneNumber' } as ColumnInput],
      });
      const warehouses = createTable(base.id, { title: 'Warehouses', columns: [text('Name', true), text('Location')] });
      let products = createTable(base.id, {
        title: 'Products',
        columns: [
          text('Name', true),
          text('SKU'),
          { title: 'Category', type: 'SingleSelect', options: { choices: choicesFrom(CATEGORIES) } } as ColumnInput,
          { title: 'Unit Price', type: 'Currency', options: { currencyCode: 'USD', precision: 2 } } as ColumnInput,
          { title: 'Reorder Level', type: 'Number' } as ColumnInput,
          { title: 'Image', type: 'Attachment' } as ColumnInput,
        ],
      });
      let movements = createTable(base.id, {
        title: 'Stock Movements',
        columns: [
          text('Reference', true),
          { title: 'Type', type: 'SingleSelect', options: { choices: choicesFrom(['In', 'Out', 'Adjustment']) } } as ColumnInput,
          { title: 'Quantity', type: 'Number' } as ColumnInput,
          { title: 'Date', type: 'Date' } as ColumnInput,
          { title: 'Note', type: 'LongText' } as ColumnInput,
        ],
      });

      const supplierLink = addColumn(products.id, { title: 'Supplier', type: 'Links', options: { relatedTableId: suppliers.id, relation: 'bt' } } as ColumnInput);
      if (supplierLink.options.symmetricColumnId) updateColumn(supplierLink.options.symmetricColumnId, { title: 'Products' } as Partial<ColumnInput>);
      const productLink = addColumn(movements.id, { title: 'Product', type: 'Links', options: { relatedTableId: products.id, relation: 'bt' } } as ColumnInput);
      const movementsColId = productLink.options.symmetricColumnId;
      if (!movementsColId) throw new Error('Template: Links column has no symmetric column');
      updateColumn(movementsColId, { title: 'Movements' } as Partial<ColumnInput>);
      const warehouseLink = addColumn(movements.id, { title: 'Warehouse', type: 'Links', options: { relatedTableId: warehouses.id, relation: 'bt' } } as ColumnInput);
      if (warehouseLink.options.symmetricColumnId) updateColumn(warehouseLink.options.symmetricColumnId, { title: 'Movements' } as Partial<ColumnInput>);

      const signedQty = addColumn(movements.id, { title: 'Signed Qty', type: 'Formula', options: { formula: "IF({Type} = 'Out', -{Quantity}, {Quantity})" } } as ColumnInput);
      addColumn(products.id, {
        title: 'On Hand',
        type: 'Rollup',
        options: { linkColumnId: movementsColId, targetColumnId: signedQty.id, rollupFunction: 'sum' },
      } as ColumnInput);
      addColumn(products.id, { title: 'Stock Value', type: 'Formula', options: { formula: '{On Hand} * {Unit Price}' } } as ColumnInput);
      const lowStock = addColumn(products.id, { title: 'Low Stock', type: 'Formula', options: { formula: "IF({On Hand} <= {Reorder Level}, 'Yes', 'No')" } } as ColumnInput);

      products = getTable(products.id);
      movements = getTable(movements.id);

      // ---- seed data ----
      const ctx = { userId };
      const sup = insertRecords(suppliers.id, [
        { [col(suppliers, 'Name').id]: 'Acme Components', [col(suppliers, 'Contact').id]: 'Dana Reyes', [col(suppliers, 'Email').id]: 'orders@acme.example', [col(suppliers, 'Phone').id]: '+1 555 0101' },
        { [col(suppliers, 'Name').id]: 'Northwind Office', [col(suppliers, 'Contact').id]: 'Sam Patel', [col(suppliers, 'Email').id]: 'sales@northwind.example', [col(suppliers, 'Phone').id]: '+1 555 0102' },
        { [col(suppliers, 'Name').id]: 'Boxworks Packaging', [col(suppliers, 'Contact').id]: 'Lee Chen', [col(suppliers, 'Email').id]: 'hello@boxworks.example', [col(suppliers, 'Phone').id]: '+1 555 0103' },
      ], ctx);
      const wh = insertRecords(warehouses.id, [
        { [col(warehouses, 'Name').id]: 'Main Warehouse', [col(warehouses, 'Location').id]: 'Springfield' },
        { [col(warehouses, 'Name').id]: 'Overflow Depot', [col(warehouses, 'Location').id]: 'Shelbyville' },
      ], ctx);

      const P = (t: string) => col(products, t).id;
      const productSeed: [string, string, string, number, number, number][] = [
        // name, sku, category, price, reorder, supplier index
        ['USB-C Cable 1m', 'EL-001', 'Electronics', 6.5, 50, 0],
        ['Wireless Mouse', 'EL-002', 'Electronics', 18.9, 20, 0],
        ['27" Monitor', 'EL-003', 'Electronics', 189, 5, 0],
        ['A4 Copy Paper (500)', 'OF-001', 'Office', 4.75, 40, 1],
        ['Ballpoint Pens (12)', 'OF-002', 'Office', 3.2, 30, 1],
        ['Desk Chair', 'FU-001', 'Furniture', 129, 4, 1],
        ['Standing Desk', 'FU-002', 'Furniture', 349, 2, 1],
        ['Shipping Box M', 'PK-001', 'Packaging', 0.85, 200, 2],
        ['Bubble Wrap Roll', 'PK-002', 'Packaging', 12.4, 15, 2],
        ['Cordless Drill', 'TO-001', 'Tools', 79, 3, 0],
      ];
      const prod = insertRecords(
        products.id,
        productSeed.map(([name, sku, cat, price, reorder, s]) => ({
          [P('Name')]: name,
          [P('SKU')]: sku,
          [P('Category')]: cat,
          [P('Unit Price')]: price,
          [P('Reorder Level')]: reorder,
          [P('Supplier')]: [sup[s].id],
        })),
        ctx,
      );

      const M = (t: string) => col(movements, t).id;
      // product index, warehouse index, type, qty, days ago
      const moves: [number, number, 'In' | 'Out' | 'Adjustment', number, number][] = [
        [0, 0, 'In', 120, 30], [0, 0, 'Out', 45, 12], [1, 0, 'In', 40, 28], [1, 0, 'Out', 25, 6],
        [2, 0, 'In', 8, 25], [2, 0, 'Out', 4, 3], [3, 1, 'In', 100, 21], [3, 1, 'Out', 70, 2],
        [4, 1, 'In', 60, 20], [4, 1, 'Out', 12, 9], [5, 0, 'In', 6, 18], [5, 0, 'Out', 3, 4],
        [6, 0, 'In', 3, 17], [6, 0, 'Out', 2, 1], [7, 1, 'In', 500, 15], [7, 1, 'Out', 180, 5],
        [8, 1, 'In', 20, 14], [8, 1, 'Adjustment', -2, 7], [9, 0, 'In', 5, 10], [9, 0, 'Out', 3, 2],
      ];
      const day = (ago: number) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
      insertRecords(
        movements.id,
        moves.map(([p, w, type, qty, ago], i) => ({
          [M('Reference')]: `MV-${String(i + 1).padStart(4, '0')}`,
          [M('Product')]: [prod[p].id],
          [M('Warehouse')]: [wh[w].id],
          [M('Type')]: type,
          [M('Quantity')]: qty,
          [M('Date')]: day(ago),
          [M('Note')]: type === 'Adjustment' ? 'Damaged in storage' : null,
        })),
        ctx,
      );

      // ---- views ----
      const kanban = createView(products.id, { title: 'By category', type: 'kanban' });
      updateView(kanban.id, { meta: { ...kanban.meta, groupColumnId: P('Category'), coverColumnId: P('Image'), stackOrder: CATEGORIES } } as Partial<View>);
      const gallery = createView(products.id, { title: 'Gallery', type: 'gallery' });
      updateView(gallery.id, { meta: { ...gallery.meta, coverColumnId: P('Image') } } as Partial<View>);
      const low = createView(products.id, { title: 'Low stock', type: 'grid' });
      updateView(low.id, { filter: { logic: 'and', children: [{ columnId: lowStock.id, op: 'eq', value: 'Yes' }] } } as Partial<View>);
      const cal = createView(movements.id, { title: 'Calendar', type: 'calendar' });
      updateView(cal.id, { meta: { ...cal.meta, dateColumnId: M('Date') } } as Partial<View>);
      const form = createView(movements.id, { title: 'Receive stock', type: 'form' });
      updateView(form.id, {
        columns: viewColumns(movements, ['Reference', 'Product', 'Warehouse', 'Type', 'Quantity', 'Date', 'Note'], {
          Product: { required: true },
          Quantity: { required: true },
          Type: { required: true },
          Reference: { help: 'Delivery note or PO number' },
        }),
        meta: { ...form.meta, formHeading: 'Receive stock', formSubheading: 'Record incoming goods', formSubmitMessage: 'Thanks, the movement was recorded.' },
      } as Partial<View>);

      audit({ baseId: base.id, userId, action: 'meta', details: { template: 'inventory' } });
      return { ...getBase(base.id), role: 'owner' as const };
    }),
  )();
}

export async function templateRoutes(app: FastifyInstance) {
  app.post('/api/v1/bases/templates/inventory', { schema: doc('Templates', 'Create the Inventory starter base') }, async (req) => {
    const user = requireUser(req);
    return createInventoryBase(user.id);
  });
}
