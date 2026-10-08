import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FilterGroup, ListQuery, Sort } from '../../../shared/src/index.js';
import { requireTableRole, requireUser } from '../auth/plugin.js';
import {
  deleteRecords,
  getRecord,
  groupRecords,
  insertRecords,
  linkRecords,
  listLinked,
  listRecords,
  unlinkRecords,
  updateRecords,
} from '../data/records.js';
import { badRequest, notFound } from '../errors.js';
import { loadColumn } from '../meta/store.js';
import { filterGroup, sortList } from './meta.js';

type Q = Record<string, string | undefined>;

function parseJsonParam<T>(raw: string | undefined, name: string, schema: z.ZodType<T>): T | undefined {
  if (raw === undefined || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest(`Query parameter "${name}" must be JSON`);
  }
  return schema.parse(parsed);
}

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

/** Parses the common list query string (viewId, offset, limit, search, searchColumnId, fields, filter, sorts). */
export function parseListQuery(query: Q): ListQuery {
  return {
    viewId: query.viewId || undefined,
    offset: num(query.offset),
    limit: num(query.limit),
    search: query.search || undefined,
    searchColumnId: query.searchColumnId || undefined,
    fields: query.fields
      ? query.fields
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    filter: parseJsonParam<FilterGroup>(query.filter, 'filter', filterGroup),
    sorts: parseJsonParam<Sort[]>(query.sorts, 'sorts', sortList),
  };
}

const idsBody = z.object({ ids: z.array(z.union([z.number(), z.string()])) });
const recordObj = z.record(z.unknown());

type P<K extends string> = { Params: Record<K, string>; Querystring: Q };

function linkColumnOf(tableId: string, columnId: string) {
  const col = loadColumn(columnId);
  if (col.tableId !== tableId) throw notFound('Column');
  return col;
}

export async function dataRoutes(app: FastifyInstance) {
  app.get<P<'tableId'>>('/api/v1/tables/:tableId/records', async (req) => {
    requireTableRole(req, req.params.tableId, 'viewer');
    return listRecords(req.params.tableId, parseListQuery(req.query));
  });

  app.get<P<'tableId' | 'id'>>('/api/v1/tables/:tableId/records/:id', async (req) => {
    requireTableRole(req, req.params.tableId, 'viewer');
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw notFound('Record');
    return getRecord(req.params.tableId, id);
  });

  app.post<P<'tableId'>>('/api/v1/tables/:tableId/records', async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    const ctx = { userId: requireUser(req).id };
    if (Array.isArray(req.body)) return insertRecords(req.params.tableId, z.array(recordObj).parse(req.body), ctx);
    return insertRecords(req.params.tableId, [recordObj.parse(req.body ?? {})], ctx)[0];
  });

  app.patch<P<'tableId'>>('/api/v1/tables/:tableId/records', async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    const rows = z.array(recordObj).parse(req.body);
    return updateRecords(req.params.tableId, rows, { userId: requireUser(req).id });
  });

  app.patch<P<'tableId' | 'id'>>('/api/v1/tables/:tableId/records/:id', async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    const body = recordObj.parse(req.body ?? {});
    return updateRecords(req.params.tableId, [{ ...body, id: req.params.id }], { userId: requireUser(req).id })[0];
  });

  app.delete<P<'tableId'>>('/api/v1/tables/:tableId/records', async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    const { ids } = idsBody.parse(req.body);
    return { deleted: deleteRecords(req.params.tableId, ids, { userId: requireUser(req).id }) };
  });

  app.delete<P<'tableId' | 'id'>>('/api/v1/tables/:tableId/records/:id', async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    const deleted = deleteRecords(req.params.tableId, [req.params.id], { userId: requireUser(req).id });
    if (!deleted) throw notFound('Record');
    return { deleted };
  });

  app.get<P<'tableId'>>('/api/v1/tables/:tableId/groups', async (req) => {
    requireTableRole(req, req.params.tableId, 'viewer');
    const q = req.query;
    if (!q.columnId) throw badRequest('columnId is required');
    return groupRecords(req.params.tableId, {
      viewId: q.viewId || undefined,
      columnId: q.columnId,
      filter: parseJsonParam<FilterGroup>(q.filter, 'filter', filterGroup),
      search: q.search || undefined,
    });
  });

  app.get<P<'tableId' | 'id' | 'columnId'>>('/api/v1/tables/:tableId/records/:id/links/:columnId', async (req) => {
    requireTableRole(req, req.params.tableId, 'viewer');
    linkColumnOf(req.params.tableId, req.params.columnId);
    const q = req.query;
    return listLinked(req.params.columnId, Number(req.params.id), {
      offset: num(q.offset),
      limit: num(q.limit),
      search: q.search || undefined,
      notLinked: q.notLinked === 'true' || q.notLinked === '1',
    });
  });

  app.post<P<'tableId' | 'id' | 'columnId'>>('/api/v1/tables/:tableId/records/:id/links/:columnId', async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    linkColumnOf(req.params.tableId, req.params.columnId);
    const { ids } = idsBody.parse(req.body);
    linkRecords(req.params.columnId, Number(req.params.id), ids as number[], { userId: requireUser(req).id });
    return { ok: true };
  });

  app.delete<P<'tableId' | 'id' | 'columnId'>>('/api/v1/tables/:tableId/records/:id/links/:columnId', async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    linkColumnOf(req.params.tableId, req.params.columnId);
    const { ids } = idsBody.parse(req.body);
    unlinkRecords(req.params.columnId, Number(req.params.id), ids as number[], { userId: requireUser(req).id });
    return { ok: true };
  });
}
