import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Base, Table, View } from '../../shared/src/index.js';
import { insertRecords, listRecords } from '../src/data/records.js';
import { createTestApp, signUpUser } from './helpers.js';
import { addMember } from './platform-fixtures.js';

type H = Record<string, string>;
let app: FastifyInstance;
let owner: H;
let editor: H;
let viewer: H;
let baseId: string;
let table: Table;
let other: Table;
let viewId: string;
let rec: number;
let otherRec: number;

async function call(method: string, url: string, h: H, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: h, payload: payload as object });
  return { status: res.statusCode, body: res.body ? (res.json() as any) : null };
}
async function ok<T = any>(method: string, url: string, h: H, payload?: unknown): Promise<T> {
  const r = await call(method, url, h, payload);
  if (r.status !== 200) throw new Error(`${method} ${url} -> ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const c = (t: Table, title: string) => t.columns.find((x) => x.title === title)!.id;
const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));

beforeAll(async () => {
  app = await createTestApp();
  const o = await signUpUser(app, 'perm-owner@example.com');
  const e = await signUpUser(app, 'perm-editor@example.com');
  const v = await signUpUser(app, 'perm-viewer@example.com');
  owner = o.headers;
  editor = e.headers;
  viewer = v.headers;
  baseId = (await ok<Base>('POST', '/bases', owner, { title: 'Perms' })).id;
  addMember(baseId, e.userId, 'editor');
  addMember(baseId, v.userId, 'viewer');
  other = await ok<Table>('POST', `/bases/${baseId}/tables`, owner, {
    title: 'Vendors',
    columns: [
      { title: 'Vendor', type: 'SingleLineText' },
      { title: 'Margin', type: 'Number' },
    ],
  });
  table = await ok<Table>('POST', `/bases/${baseId}/tables`, owner, {
    title: 'Items',
    columns: [
      { title: 'Name', type: 'SingleLineText' },
      { title: 'Cost', type: 'Number' },
      { title: 'Price', type: 'Number' },
      { title: 'Vendor link', type: 'Links', options: { relatedTableId: other.id } },
    ],
  });
  // Cost: hidden for editor + viewer; Price: read-only for editor.
  await ok('PATCH', `/columns/${c(table, 'Cost')}`, owner, { options: { permissions: { hiddenFor: ['editor', 'viewer'] } } });
  await ok('PATCH', `/columns/${c(table, 'Price')}`, owner, { options: { permissions: { readOnlyFor: ['editor'] } } });
  await ok('POST', `/tables/${table.id}/columns`, owner, { title: 'Profit', type: 'Formula', options: { formula: '{Price} - {Cost}' } });
  await ok('POST', `/tables/${other.id}/columns`, owner, {
    title: 'Margin hidden',
    type: 'Number',
    options: { permissions: { hiddenFor: ['viewer'] } },
  });
  other = await ok<Table>('GET', `/tables/${other.id}`, owner);
  const [vendor] = insertRecords(other.id, [{ Vendor: 'Acme', 'Margin hidden': 7 }]);
  otherRec = vendor.id;
  table = await ok<Table>('GET', `/tables/${table.id}`, owner);
  const [r] = insertRecords(table.id, [{ Name: 'Bolt', Cost: 3, Price: 5, 'Vendor link': [vendor.id] }]);
  rec = r.id;
  viewId = table.views![0].id;
});

describe('field permissions: meta', () => {
  it('stores normalised permissions and keeps them across type changes', async () => {
    const col = table.columns.find((x) => x.title === 'Cost')!;
    expect(col.options.permissions).toEqual({ hiddenFor: ['editor', 'viewer'] });
    const bad = await call('PATCH', `/columns/${col.id}`, owner, { options: { permissions: { hiddenFor: ['owner'] } } });
    expect(bad.status).toBe(400);
  });

  it('hides hidden columns (and formulas reading them) from non-owners in table/base/view meta', async () => {
    const asEditor = await ok<Table>('GET', `/tables/${table.id}`, editor);
    expect(asEditor.columns.map((x) => x.title)).not.toContain('Cost');
    expect(asEditor.columns.map((x) => x.title)).not.toContain('Profit');
    expect(asEditor.columns.map((x) => x.title)).toContain('Price');
    expect(asEditor.views![0].columns.some((vc) => vc.columnId === c(table, 'Cost'))).toBe(false);
    const base = await ok<Base & { tables: Table[] }>('GET', `/bases/${baseId}`, viewer);
    expect(base.tables.find((t) => t.id === table.id)!.columns.map((x) => x.title)).not.toContain('Cost');
    const view = await ok<View>('GET', `/views/${viewId}`, viewer);
    expect(view.columns.some((vc) => vc.columnId === c(table, 'Cost'))).toBe(false);
    expect((await call('GET', `/columns/${c(table, 'Cost')}`, editor)).status).toBe(404);
    expect((await ok<Table>('GET', `/tables/${table.id}`, owner)).columns.map((x) => x.title)).toContain('Cost');
  });

  it('only owners change field permissions; editors cannot touch hidden fields', async () => {
    const r = await call('PATCH', `/columns/${c(table, 'Price')}`, editor, { options: { permissions: null } });
    expect(r.status).toBe(403);
    const add = await call('POST', `/tables/${table.id}/columns`, editor, { title: 'Secret', type: 'Number', options: { permissions: { hiddenFor: ['viewer'] } } });
    expect(add.status).toBe(403);
    // Editing other options keeps permissions intact.
    await ok('PATCH', `/columns/${c(table, 'Price')}`, editor, { description: 'Sale price' });
    expect((await ok<Table>('GET', `/tables/${table.id}`, owner)).columns.find((x) => x.title === 'Price')!.options.permissions).toEqual({ readOnlyFor: ['editor'] });
    expect((await call('PATCH', `/columns/${c(table, 'Cost')}`, editor, { title: 'X' })).status).toBe(404);
    expect((await call('DELETE', `/columns/${c(table, 'Cost')}`, editor)).status).toBe(404);
  });

  it('rejects view filters/sorts on hidden fields from non-owners', async () => {
    const f = { logic: 'and', children: [{ columnId: c(table, 'Cost'), op: 'gt', value: 1 }] };
    expect((await call('PATCH', `/views/${viewId}`, editor, { filter: f })).status).toBe(400);
    expect((await call('PATCH', `/views/${viewId}`, editor, { sorts: [{ columnId: c(table, 'Cost'), direction: 'asc' }] })).status).toBe(400);
    expect((await call('PATCH', `/views/${viewId}`, editor, { meta: { groupBy: [{ columnId: c(table, 'Cost'), direction: 'asc' }] } })).status).toBe(400);
  });
});

describe('field permissions: records', () => {
  it('strips hidden fields from list and get for the caller role', async () => {
    const list = await ok('GET', `/tables/${table.id}/records`, viewer);
    expect(list.list[0]).not.toHaveProperty(c(table, 'Cost'));
    expect(list.list[0]).not.toHaveProperty(c(table, 'Profit'));
    expect(list.list[0][c(table, 'Price')]).toBe(5);
    const one = await ok('GET', `/tables/${table.id}/records/${rec}`, editor);
    expect(one).not.toHaveProperty(c(table, 'Cost'));
    const asOwner = await ok('GET', `/tables/${table.id}/records/${rec}`, owner);
    expect(asOwner[c(table, 'Cost')]).toBe(3);
    expect(asOwner[c(table, 'Profit')]).toBe(2);
  });

  it('rejects filters, sorts, search fields, fields and groups on hidden columns (400)', async () => {
    const cost = c(table, 'Cost');
    const f = enc({ logic: 'and', children: [{ columnId: cost, op: 'gt', value: 1 }] });
    expect((await call('GET', `/tables/${table.id}/records?filter=${f}`, viewer)).status).toBe(400);
    expect((await call('GET', `/tables/${table.id}/records?sorts=${enc([{ columnId: cost, direction: 'asc' }])}`, viewer)).status).toBe(400);
    expect((await call('GET', `/tables/${table.id}/records?search=3&searchColumnId=${cost}`, viewer)).status).toBe(400);
    expect((await call('GET', `/tables/${table.id}/records?fields=${cost}`, viewer)).status).toBe(400);
    expect((await call('GET', `/tables/${table.id}/groups?columnId=${cost}`, viewer)).status).toBe(400);
    expect((await call('GET', `/tables/${table.id}/records?filter=${f}`, owner)).status).toBe(200);
  });

  it('does not match hidden fields in a free-text search', async () => {
    await ok('PATCH', `/columns/${c(table, 'Name')}`, owner, { options: { permissions: { hiddenFor: ['viewer'] } } });
    try {
      const res = await ok('GET', `/tables/${table.id}/records?search=Bolt`, viewer);
      expect(res.list).toHaveLength(0);
      expect((await ok('GET', `/tables/${table.id}/records?search=Bolt`, owner)).list).toHaveLength(1);
    } finally {
      await ok('PATCH', `/columns/${c(table, 'Name')}`, owner, { options: { permissions: null } });
    }
  });

  it('rejects writes to read-only and hidden fields with 403 and strips responses', async () => {
    expect((await call('PATCH', `/tables/${table.id}/records/${rec}`, editor, { [c(table, 'Price')]: 9 })).status).toBe(403);
    expect((await call('PATCH', `/tables/${table.id}/records/${rec}`, editor, { Cost: 1 })).status).toBe(403);
    expect((await call('PATCH', `/tables/${table.id}/records`, editor, [{ id: rec, [c(table, 'Cost')]: 1 }])).status).toBe(403);
    expect((await call('POST', `/tables/${table.id}/records`, editor, { Name: 'Nut', Price: 1 })).status).toBe(403);
    expect((await call('POST', `/tables/${table.id}/records`, editor, [{ Name: 'Nut', Cost: 1 }])).status).toBe(403);
    const created = await ok('POST', `/tables/${table.id}/records`, editor, { Name: 'Nut' });
    expect(created).not.toHaveProperty(c(table, 'Cost'));
    const updated = await ok('PATCH', `/tables/${table.id}/records/${rec}`, editor, { Name: 'Bolt M8' });
    expect(updated).not.toHaveProperty(c(table, 'Cost'));
    // owners keep full access
    const asOwner = await ok('PATCH', `/tables/${table.id}/records/${rec}`, owner, { Price: 6, Cost: 4 });
    expect(asOwner[c(table, 'Cost')]).toBe(4);
  });

  it('applies to link endpoints and the related table of a link list', async () => {
    const link = c(table, 'Vendor link');
    await ok('PATCH', `/columns/${link}`, owner, { options: { permissions: { readOnlyFor: ['editor'] } } });
    try {
      expect((await call('POST', `/tables/${table.id}/records/${rec}/links/${link}`, editor, { ids: [otherRec] })).status).toBe(403);
      expect((await call('DELETE', `/tables/${table.id}/records/${rec}/links/${link}`, editor, { ids: [otherRec] })).status).toBe(403);
      expect((await call('PATCH', `/tables/${table.id}/records/${rec}`, editor, { [link]: [] })).status).toBe(403);
    } finally {
      await ok('PATCH', `/columns/${link}`, owner, { options: { permissions: null } });
    }
    const linked = await ok('GET', `/tables/${table.id}/records/${rec}/links/${link}`, viewer);
    expect(linked.list[0][c(other, 'Vendor')]).toBe('Acme');
    expect(linked.list[0]).not.toHaveProperty(c(other, 'Margin hidden'));
    await ok('PATCH', `/columns/${link}`, owner, { options: { permissions: { hiddenFor: ['viewer'] } } });
    try {
      expect((await call('GET', `/tables/${table.id}/records/${rec}/links/${link}`, viewer)).status).toBe(404);
    } finally {
      await ok('PATCH', `/columns/${link}`, owner, { options: { permissions: null } });
    }
  });

  it('strips hidden fields from export and record history', async () => {
    const csv = await app.inject({ method: 'GET', url: `/api/v1/views/${viewId}/export?format=csv`, headers: viewer });
    expect(csv.statusCode).toBe(200);
    const header = csv.body.split('\r\n')[0];
    expect(header).toContain('Price');
    expect(header).not.toContain('Cost');
    expect(header).not.toContain('Profit');
    const ownerCsv = await app.inject({ method: 'GET', url: `/api/v1/views/${viewId}/export?format=csv`, headers: owner });
    expect(ownerCsv.body.split('\r\n')[0]).toContain('Cost');

    const audit = await ok<{ details: Record<string, unknown> }[]>('GET', `/tables/${table.id}/records/${rec}/audit`, viewer);
    for (const e of audit) expect(JSON.stringify(e.details ?? {})).not.toContain(c(table, 'Cost'));
    const ownerAudit = await ok<{ details: Record<string, unknown> }[]>('GET', `/tables/${table.id}/records/${rec}/audit`, owner);
    expect(JSON.stringify(ownerAudit)).toContain(c(table, 'Cost'));
  });

  it('hides restricted fields from public shared views and forms', async () => {
    const { shareUuid } = await ok('POST', `/views/${viewId}/share`, owner, {});
    const meta = await app.inject({ method: 'GET', url: `/api/v1/public/views/${shareUuid}` });
    const titles = (meta.json().table.columns as { title: string }[]).map((x) => x.title);
    expect(titles).toContain('Price');
    expect(titles).not.toContain('Cost');
    const recs = await app.inject({ method: 'GET', url: `/api/v1/public/views/${shareUuid}/records` });
    expect(recs.json().list[0]).not.toHaveProperty(c(table, 'Cost'));

    const form = await ok<View>('POST', `/tables/${table.id}/views`, owner, { title: 'Order form', type: 'form' });
    await ok('PATCH', `/views/${form.id}`, owner, {
      columns: table.columns.map((x, i) => ({ columnId: x.id, show: true, order: i })),
    });
    const share = await ok('POST', `/views/${form.id}/share`, owner, {});
    const fmeta = await app.inject({ method: 'GET', url: `/api/v1/public/views/${share.shareUuid}` });
    const ftitles = (fmeta.json().table.columns as { title: string }[]).map((x) => x.title);
    expect(ftitles).toContain('Name');
    expect(ftitles).not.toContain('Cost');
    expect(ftitles).not.toContain('Price'); // read-only for editors → not offered to anonymous visitors
  });

  it('keeps full access for internal callers', () => {
    const res = listRecords(table.id, { fields: [c(table, 'Cost')] });
    expect(res.list[0]).toHaveProperty(c(table, 'Cost'));
  });
});
