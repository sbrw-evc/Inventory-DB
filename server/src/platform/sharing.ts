import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Column, FilterCondition, FilterGroup, ListQuery, RecordData, Sort, Table, View } from '../../../shared/src/index.js';
import { isFilterGroup, isReadOnlyType } from '../../../shared/src/index.js';
import { requireViewRole } from '../auth/plugin.js';
import { insertRecords, listRecords } from '../data/records.js';
import { getDb } from '../db/index.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import { getTable, getView } from '../meta/service.js';
import { doc } from './docs.js';
import { pickColumns, shownColumns, type ShownColumn } from './viewColumns.js';

interface SharedRow {
  id: string;
  table_id: string;
  type: View['type'];
  share_password_hash: string | null;
}

/** Wrong share passwords per (share, client IP) within a sliding window; in memory, per process. */
const MAX_PASSWORD_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, number[]>();

function recentFailures(key: string): number[] {
  const cutoff = Date.now() - FAILURE_WINDOW_MS;
  const list = (failures.get(key) ?? []).filter((t) => t > cutoff);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

const tooManyFailures = (key: string) => recentFailures(key).length >= MAX_PASSWORD_FAILURES;

function recordFailure(key: string) {
  failures.set(key, [...recentFailures(key), Date.now()]);
}

/** Resolve a share uuid and check the optional password (`xc-password` header). */
async function resolveShare(req: FastifyRequest, uuid: string): Promise<SharedRow> {
  const row = getDb().prepare('SELECT id, table_id, type, share_password_hash FROM nc_views WHERE share_uuid = ?').get(uuid) as SharedRow | undefined;
  if (!row) throw notFound('Shared view');
  if (row.share_password_hash) {
    const given = req.headers['xc-password'];
    if (typeof given !== 'string' || !given) throw new HttpError(401, 'PASSWORD_REQUIRED', 'This shared view is password protected');
    const key = `${uuid}|${req.ip}`;
    if (tooManyFailures(key)) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong passwords, try again later');
    if (!(await bcrypt.compare(given, row.share_password_hash))) {
      recordFailure(key);
      throw new HttpError(401, 'PASSWORD_REQUIRED', 'This shared view is password protected');
    }
    failures.delete(key);
  }
  return row;
}

function sharedContext(row: SharedRow): { view: View; table: Table; shown: ShownColumn[]; ids: Set<string> } {
  const view = getView(row.id);
  const table = getTable(row.table_id);
  const shown = shownColumns(table, view);
  return { view, table, shown, ids: new Set(shown.map((s) => s.column.id)) };
}

/** Public meta: only shown columns, no table internals beyond what rendering needs. */
function publicMeta(view: View, table: Table, shown: ShownColumn[], ids: Set<string>) {
  return {
    view: {
      id: view.id,
      tableId: view.tableId,
      title: view.title,
      type: view.type,
      columns: view.columns.filter((c) => ids.has(c.columnId)),
      sorts: view.sorts.filter((s) => ids.has(s.columnId)),
      meta: view.meta,
      shareUuid: view.shareUuid,
    },
    table: {
      id: table.id,
      title: table.title,
      columns: shown.map(({ column }) => column),
    },
  };
}

function filterUsesOnly(f: FilterGroup | FilterCondition, ids: Set<string>): boolean {
  return isFilterGroup(f) ? f.children.every((c) => filterUsesOnly(c, ids)) : ids.has(f.columnId);
}

const parseJson = <T>(raw: string | undefined, what: string): T | undefined => {
  if (raw == null || raw === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw badRequest(`Invalid ${what} JSON`);
  }
};

type ListQs = { offset?: string; limit?: string; search?: string; searchColumnId?: string; filter?: string; sorts?: string };

/** Records-list query from querystring, restricted to the shown columns so hidden data can't be probed. */
function publicListQuery(qs: ListQs, viewId: string, ids: Set<string>): ListQuery {
  const filter = parseJson<FilterGroup>(qs.filter, 'filter');
  const sorts = parseJson<Sort[]>(qs.sorts, 'sorts');
  if (filter && !filterUsesOnly(filter, ids)) throw badRequest('Filter references a hidden field');
  if (sorts && (!Array.isArray(sorts) || sorts.some((s) => !ids.has(s.columnId)))) throw badRequest('Sort references a hidden field');
  if (qs.searchColumnId && !ids.has(qs.searchColumnId)) throw badRequest('Search references a hidden field');
  return {
    viewId,
    offset: Math.max(0, Number(qs.offset) || 0),
    limit: Math.min(1000, Math.max(1, Number(qs.limit) || 25)),
    search: qs.search || undefined,
    searchColumnId: qs.searchColumnId || undefined,
    filter,
    sorts,
    fields: [...ids],
  };
}

const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** Validate a shared-form submission: only shown, writable fields; required overrides enforced. */
export function formRow(shown: ShownColumn[], body: Record<string, unknown>): Record<string, unknown> {
  const byKey = new Map<string, Column>();
  for (const { column } of shown) {
    byKey.set(column.id, column);
    byKey.set(column.title.toLowerCase(), column);
  }
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    const col = byKey.get(k) ?? byKey.get(k.toLowerCase());
    if (!col) continue; // silently drop hidden/unknown fields
    if (isReadOnlyType(col.type) && col.type !== 'Links') continue;
    row[col.id] = v;
  }
  const missing = shown
    .filter(({ column, viewColumn }) => (viewColumn?.required ?? column.required) && !(isReadOnlyType(column.type) && column.type !== 'Links'))
    .filter(({ column }) => isEmpty(row[column.id]))
    .map(({ column, viewColumn }) => ({ columnId: column.id, title: viewColumn?.label || column.title }));
  if (missing.length) throw badRequest(`Required: ${missing.map((m) => m.title).join(', ')}`, { missing });
  return row;
}

export async function sharingRoutes(app: FastifyInstance) {
  app.post<{ Params: { viewId: string } }>('/api/v1/views/:viewId/share', { schema: doc('Sharing', 'Enable (or update) public sharing of a view') }, async (req) => {
    requireViewRole(req, req.params.viewId, 'editor');
    const body = z.object({ password: z.string().min(1).max(200).nullable().optional() }).parse(req.body ?? {});
    const db = getDb();
    const cur = db.prepare('SELECT share_uuid, share_password_hash FROM nc_views WHERE id = ?').get(req.params.viewId) as {
      share_uuid: string | null;
      share_password_hash: string | null;
    };
    const shareUuid = cur.share_uuid ?? randomUUID();
    let hash = cur.share_password_hash;
    if (body.password === null) hash = null;
    else if (typeof body.password === 'string') hash = await bcrypt.hash(body.password, 10);
    db.prepare('UPDATE nc_views SET share_uuid = ?, share_password_hash = ? WHERE id = ?').run(shareUuid, hash, req.params.viewId);
    return { shareUuid, passwordSet: !!hash };
  });

  app.delete<{ Params: { viewId: string } }>('/api/v1/views/:viewId/share', { schema: doc('Sharing', 'Disable public sharing of a view') }, async (req) => {
    requireViewRole(req, req.params.viewId, 'editor');
    getDb().prepare('UPDATE nc_views SET share_uuid = NULL, share_password_hash = NULL WHERE id = ?').run(req.params.viewId);
    return { ok: true };
  });

  app.get<{ Params: { uuid: string } }>('/api/v1/public/views/:uuid', { schema: doc('Sharing', 'Shared view meta (header xc-password if protected)') }, async (req) => {
    const row = await resolveShare(req, req.params.uuid);
    const { view, table, shown, ids } = sharedContext(row);
    return publicMeta(view, table, shown, ids);
  });

  app.get<{ Params: { uuid: string }; Querystring: ListQs }>(
    '/api/v1/public/views/:uuid/records',
    { schema: doc('Sharing', 'Records of a shared view (shown fields only)') },
    async (req) => {
      const row = await resolveShare(req, req.params.uuid);
      if (row.type === 'form') throw notFound('Shared view');
      const { ids } = sharedContext(row);
      const res = listRecords(row.table_id, publicListQuery(req.query, row.id, ids));
      return { ...res, list: res.list.map((r) => pickColumns(r, ids)) };
    },
  );

  app.post<{ Params: { uuid: string } }>('/api/v1/public/views/:uuid/submit', { schema: doc('Sharing', 'Submit a shared form') }, async (req) => {
    const row = await resolveShare(req, req.params.uuid);
    if (row.type !== 'form') throw badRequest('Only form views accept submissions');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected an object');
    const { shown, ids } = sharedContext(row);
    const data = formRow(shown, body as Record<string, unknown>);
    const [created] = insertRecords(row.table_id, [data], { userId: null });
    return pickColumns(created as RecordData, ids);
  });
}
