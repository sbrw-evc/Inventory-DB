import { afterEach, describe, expect, it } from 'vitest';
import { NocoDBClient, NocoDBError, mapConcurrent, normalizeBaseUrl } from '../src/migrate/nocodbClient.js';
import { MOCK_TOKEN, startMockNocoDB, type MockNocoDB, type MockOptions } from './migrateNocodbMock.js';

let mock: MockNocoDB | null = null;
afterEach(async () => {
  await mock?.close();
  mock = null;
});

async function setup(opts: MockOptions = {}, token = MOCK_TOKEN, clientOpts: { pageSize?: number } = {}) {
  mock = await startMockNocoDB(opts);
  return new NocoDBClient({ url: mock.url, token, retryBaseMs: 1, ...clientOpts });
}

describe('normalizeBaseUrl', () => {
  it('adds https, strips trailing slashes, hashes and api/dashboard paths', () => {
    expect(normalizeBaseUrl('app.nocodb.com')).toBe('https://app.nocodb.com');
    expect(normalizeBaseUrl(' https://app.nocodb.com/ ')).toBe('https://app.nocodb.com');
    expect(normalizeBaseUrl('https://app.nocodb.com/#/wsk1/pinv0001')).toBe('https://app.nocodb.com');
    expect(normalizeBaseUrl('http://localhost:8080/dashboard/#/nc/p1')).toBe('http://localhost:8080');
    expect(normalizeBaseUrl('https://example.com/nocodb/api/v2/meta/bases')).toBe('https://example.com/nocodb');
    expect(() => normalizeBaseUrl('')).toThrow(NocoDBError);
    expect(() => normalizeBaseUrl('ftp://x')).toThrow(NocoDBError);
  });
});

describe('NocoDBClient against a mock NocoDB', () => {
  it('lists bases through workspaces (cloud)', async () => {
    const c = await setup();
    expect(await c.listBases()).toEqual([{ id: 'pinv0001', title: 'Inventory' }]);
    expect(mock!.requests.map((r) => r.path)).toEqual(['/api/v2/meta/workspaces', '/api/v2/meta/workspaces/wsk1abcd/bases']);
    expect(mock!.requests.every((r) => r.token === MOCK_TOKEN)).toBe(true);
  });

  it('falls back to /meta/bases on self-hosted', async () => {
    const c = await setup({ workspaces: false });
    expect(await c.listBases()).toEqual([
      { id: 'pinv0001', title: 'Inventory' },
      { id: 'pcrm0002', title: 'CRM' },
    ]);
  });

  it('reports an invalid token clearly without leaking it', async () => {
    const c = await setup({}, 'wrong-token-value');
    const err = await c.listBases().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NocoDBError);
    expect((err as Error).message).toBe('Invalid NocoDB API token');
    expect((err as NocoDBError).status).toBe(401);
  });

  it('reports a non-NocoDB / unreachable URL', async () => {
    const c = new NocoDBClient({ url: 'http://127.0.0.1:1', token: 't', maxRetries: 0 });
    await expect(c.getTable('x')).rejects.toThrow(/Could not reach NocoDB/);
  });

  it('retries 429 responses', async () => {
    const c = await setup({ rateLimitTimes: 2 });
    const tables = await c.listTables('pinv0001');
    expect(tables.map((t) => t.title)).toEqual(['Products', 'Suppliers', 'nc_m2m_tags_products', 'low_stock_sql_view']);
    expect(mock!.requests.filter((r) => r.path === '/api/v2/meta/bases/pinv0001/tables')).toHaveLength(3);
  });

  it('gives up after max retries', async () => {
    mock = await startMockNocoDB({ rateLimitTimes: 10 });
    const c = new NocoDBClient({ url: mock.url, token: MOCK_TOKEN, retryBaseMs: 1, maxRetries: 1 });
    await expect(c.listTables('pinv0001')).rejects.toThrow(/rate limit/);
  });

  it('reads table meta with columns', async () => {
    const c = await setup();
    const t = await c.getTable('mdprod01');
    expect(t.title).toBe('Products');
    expect(t.columns.find((x) => x.title === 'Category')?.colOptions?.options).toHaveLength(2);
  });

  it('pages through records', async () => {
    const c = await setup({ maxLimit: 2 }, MOCK_TOKEN, { pageSize: 2 });
    const pages: number[] = [];
    for await (const p of c.iterateRecords('mdprod01')) pages.push(p.length);
    expect(pages).toEqual([2, 1]);
    const offsets = mock!.requests.filter((r) => r.path.endsWith('/records')).map((r) => r.query.offset);
    expect(offsets).toEqual(['0', '2']);
  });

  it('keeps paging when the server caps the page size below ours', async () => {
    const c = await setup({ maxLimit: 1 });
    const rows: unknown[] = [];
    for await (const p of c.iterateRecords('mdprod01')) rows.push(...p);
    expect(rows).toHaveLength(3);
  });

  it('builds the filter tree, fetching group children', async () => {
    const c = await setup();
    const roots = await c.getFilters('vwpstk02');
    expect(roots).toHaveLength(3);
    expect(roots[1]!.children?.map((f) => f.comparison_op)).toEqual(['gt', 'anyof']);
    expect(await c.getFilters('vwpgrid1')).toEqual([]);
  });

  it('builds the filter tree from a flat list with fk_parent_id', async () => {
    const c = await setup();
    const flat = [
      { id: 'g', is_group: true, logical_op: 'and' },
      { id: 'a', fk_parent_id: 'g', fk_column_id: 'x', comparison_op: 'eq', value: '1' },
    ];
    const fakeFetch = (async () => new Response(JSON.stringify({ list: flat }), { status: 200 })) as typeof fetch;
    const c2 = new NocoDBClient({ url: mock!.url, token: 't', fetch: fakeFetch });
    const roots = await c2.getFilters('v');
    expect(roots).toHaveLength(1);
    expect(roots[0]!.children?.[0]?.id).toBe('a');
    void c;
  });

  it('reads sorts, view columns and type-specific view settings', async () => {
    const c = await setup();
    expect((await c.getSorts('vwpstk02')).map((s) => s.direction)).toEqual(['desc', 'asc']);
    expect((await c.getViewColumns('vwpstk02'))[0]).toMatchObject({ fk_column_id: 'clptit02', width: '240px' });
    expect(await c.getViewDetails('kanbans', 'vwpkan03')).toMatchObject({ fk_grp_col_id: 'clpcat04' });
    expect(await c.getViewDetails('calendars', 'nope')).toBeNull();
  });

  it('lists linked records (has-many list and belongs-to object)', async () => {
    const c = await setup();
    expect((await c.listLinks('mdsupp02', 'clsprd03', 1)).map((r) => r.Id)).toEqual([1, 2]);
    expect(await c.listLinks('mdsupp02', 'clsprd03', 2)).toEqual([]);
    expect(await c.listLinks('mdprod01', 'clpsup09', 1)).toEqual([{ Id: 1, Name: 'Acme' }]);
    expect(await c.listLinks('mdprod01', 'clpsup09', 3)).toEqual([]);
  });

  it('limits concurrency', async () => {
    let active = 0;
    let peak = 0;
    const fakeFetch = (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response('{"list":[]}', { status: 200 });
    }) as typeof fetch;
    const c = new NocoDBClient({ url: 'https://x.example.com', token: 't', fetch: fakeFetch, concurrency: 2 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => c.listViews(`t${i}`)));
    expect(peak).toBe(2);
    expect(await mapConcurrent([1, 2, 3], 2, async (n) => n * 2)).toEqual([2, 4, 6]);
  });

  it('rejects non-JSON responses with a helpful message', async () => {
    const fakeFetch = (async () => new Response('<html>login</html>', { status: 200 })) as typeof fetch;
    const c = new NocoDBClient({ url: 'https://x.example.com', token: 't', fetch: fakeFetch });
    await expect(c.listTables('b')).rejects.toThrow(/non-JSON/);
  });
});
