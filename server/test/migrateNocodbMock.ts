/** A tiny fake NocoDB (v2 API) on an ephemeral port, serving the JSON fixtures in fixtures/nocodb. */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nocodb');
export const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as T;

export const MOCK_TOKEN = 'nc-test-token-0123456789';

export interface MockOptions {
  /** Serve the cloud workspaces endpoints (default true); false behaves like self-hosted CE (404). */
  workspaces?: boolean;
  /** Return 429 this many times before succeeding (per path). */
  rateLimitTimes?: number;
  /** Cap applied to `limit` like NocoDB's DB_QUERY_LIMIT_MAX. */
  maxLimit?: number;
}

export interface MockNocoDB {
  url: string;
  requests: { path: string; query: Record<string, string>; token: string | undefined }[];
  close(): Promise<void>;
}

const page = (rows: unknown[], offset: number, limit: number) => {
  const list = rows.slice(offset, offset + limit);
  return {
    list,
    pageInfo: {
      totalRows: rows.length,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      isFirstPage: offset === 0,
      isLastPage: offset + list.length >= rows.length,
    },
  };
};

export async function startMockNocoDB(opts: MockOptions = {}): Promise<MockNocoDB> {
  const requests: MockNocoDB['requests'] = [];
  const throttled = new Map<string, number>();
  const records: Record<string, unknown[]> = {
    mdprod01: fixture('records-products'),
    mdsupp02: fixture('records-suppliers'),
  };
  const routes: Record<string, () => unknown> = {
    '/api/v2/meta/bases': () => fixture('meta-bases'),
    '/api/v2/meta/bases/pinv0001': () => (fixture('meta-bases') as { list: unknown[] }).list[0],
    '/api/v2/meta/bases/pinv0001/tables': () => fixture('base-tables'),
    '/api/v2/meta/tables/mdprod01': () => fixture('table-products'),
    '/api/v2/meta/tables/mdsupp02': () => fixture('table-suppliers'),
    '/api/v2/meta/tables/mdprod01/views': () => fixture('views-products'),
    '/api/v2/meta/tables/mdsupp02/views': () => fixture('views-suppliers'),
    '/api/v2/meta/views/vwpstk02/filters': () => fixture('filters-instock'),
    '/api/v2/meta/filters/fltgrp02/children': () => fixture('filter-children-grp02'),
    '/api/v2/meta/views/vwpstk02/sorts': () => fixture('sorts-instock'),
    '/api/v2/meta/views/vwpstk02/columns': () => fixture('columns-instock'),
    '/api/v2/meta/kanbans/vwpkan03': () => fixture('kanban-bycategory'),
    '/api/v2/meta/forms/vwsfrm02': () => fixture('form-newsupplier'),
  };
  if (opts.workspaces !== false) {
    routes['/api/v2/meta/workspaces'] = () => fixture('meta-workspaces');
    routes['/api/v2/meta/workspaces/wsk1abcd/bases'] = () => ({ list: [(fixture('meta-bases') as { list: unknown[] }).list[0]] });
  }

  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const token = req.headers['xc-token'] as string | undefined;
    requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), token });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (token !== MOCK_TOKEN) return send(401, { msg: 'Invalid token' });
    if (opts.rateLimitTimes) {
      const n = throttled.get(u.pathname) ?? 0;
      if (n < opts.rateLimitTimes) {
        throttled.set(u.pathname, n + 1);
        return send(429, { msg: 'Too many requests' }, { 'retry-after': '0' });
      }
    }
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const limit = Math.min(Number(u.searchParams.get('limit') ?? 25), opts.maxLimit ?? 1000);

    let m = /^\/api\/v2\/tables\/([^/]+)\/records$/.exec(u.pathname);
    if (m && records[m[1]!]) return send(200, page(records[m[1]!]!, offset, limit));
    m = /^\/api\/v2\/tables\/([^/]+)\/links\/([^/]+)\/records\/([^/]+)$/.exec(u.pathname);
    if (m) {
      if (m[1] === 'mdsupp02' && m[2] === 'clsprd03' && m[3] === '1') return send(200, fixture('links-suppliers-products-1'));
      if (m[1] === 'mdprod01' && m[2] === 'clpsup09') {
        const p = (records.mdprod01 as { Id: number; Supplier: unknown }[]).find((r) => String(r.Id) === m![3]);
        return send(200, p?.Supplier ?? {});
      }
      return send(200, { list: [], pageInfo: { totalRows: 0, isFirstPage: true, isLastPage: true } });
    }
    if (/^\/api\/v2\/meta\/views\/[^/]+\/(filters|sorts|columns)$/.test(u.pathname) && !routes[u.pathname]) {
      return send(200, { list: [] });
    }
    const route = routes[u.pathname];
    if (route) return send(200, route());
    return send(404, { msg: `Cannot GET ${u.pathname}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
