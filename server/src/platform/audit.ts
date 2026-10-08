import type { FastifyInstance } from 'fastify';
import type { AuditEntry, FieldType, RecordData } from '../../../shared/src/index.js';
import { isReadOnlyType } from '../../../shared/src/index.js';
import { requireBaseRole, requireTableRole } from '../auth/plugin.js';
import { getDb, json, newId, now } from '../db/index.js';
import { bus, type RecordEventContext } from '../events.js';
import { notFound } from '../errors.js';
import { doc } from './docs.js';

export interface AuditInput {
  baseId: string;
  tableId?: string | null;
  recordId?: number | null;
  userId?: string | null;
  action: AuditEntry['action'];
  details?: unknown;
}

/** Write one audit row. Used by the record event listeners and for meta changes / imports. */
export function audit(entry: AuditInput): void {
  getDb()
    .prepare(
      `INSERT INTO nc_audit (id, base_id, table_id, record_id, user_id, action, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId('aud'),
      entry.baseId,
      entry.tableId ?? null,
      entry.recordId ?? null,
      entry.userId ?? null,
      entry.action,
      entry.details === undefined ? null : JSON.stringify(entry.details),
      now(),
    );
}

let suppressed = 0;
/** Run `fn` without per-record audit rows (bulk imports and templates record one summary entry instead). */
export function withoutRecordAudit<T>(fn: () => T): T {
  suppressed++;
  try {
    return fn();
  } finally {
    suppressed--;
  }
}
export async function withoutRecordAuditAsync<T>(fn: () => Promise<T>): Promise<T> {
  suppressed++;
  try {
    return await fn();
  } finally {
    suppressed--;
  }
}

/** Column ids of a table whose values are user data (not computed / system maintained). */
function writableColumnIds(tableId: string): Set<string> {
  const rows = getDb().prepare('SELECT id, type FROM nc_columns WHERE table_id = ?').all(tableId) as { id: string; type: FieldType }[];
  return new Set(rows.filter((r) => !isReadOnlyType(r.type)).map((r) => r.id));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Only user-entered, non-empty values (a compact snapshot for insert/delete history). */
function snapshot(rec: RecordData, cols: Set<string>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (cols.has(k) && v != null && v !== '' && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  }
  return out;
}

/** `{columnId: {from, to}}` for changed user fields only. */
export function diffRecords(before: RecordData, after: RecordData, cols: Set<string>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!cols.has(k)) continue;
    if (!(k in after)) continue; // partial record: not part of the update
    if (!same(before[k], after[k])) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return out;
}

function onInsert(ctx: RecordEventContext, records: RecordData[]) {
  if (suppressed) return;
  const cols = writableColumnIds(ctx.tableId);
  for (const r of records) audit({ ...ctx, recordId: r.id, action: 'insert', details: snapshot(r, cols) });
}

function onUpdate(ctx: RecordEventContext, changes: { before: RecordData; after: RecordData }[]) {
  if (suppressed) return;
  const cols = writableColumnIds(ctx.tableId);
  for (const { before, after } of changes) {
    const details = diffRecords(before, after, cols);
    if (Object.keys(details).length) audit({ ...ctx, recordId: after.id, action: 'update', details });
  }
}

function onDelete(ctx: RecordEventContext, records: RecordData[]) {
  if (suppressed) return;
  const cols = writableColumnIds(ctx.tableId);
  for (const r of records) audit({ ...ctx, recordId: r.id, action: 'delete', details: snapshot(r, cols) });
}

function onLink(ctx: RecordEventContext & { columnId: string; recordId: number; linkedIds: number[]; unlink: boolean }) {
  if (suppressed) return;
  audit({
    baseId: ctx.baseId,
    tableId: ctx.tableId,
    userId: ctx.userId,
    recordId: ctx.recordId,
    action: ctx.unlink ? 'unlink' : 'link',
    details: { columnId: ctx.columnId, ids: ctx.linkedIds },
  });
}

/** Never let an audit failure break the write that triggered it. */
const safe =
  <A extends unknown[]>(fn: (...a: A) => void) =>
  (...a: A) => {
    try {
      fn(...a);
    } catch (err) {
      console.error('audit failed', err);
    }
  };

let registered = false;
/** Subscribes to record events once per process (safe to call from every app instance). */
export function initAudit() {
  if (registered) return;
  registered = true;
  bus.on('record.insert', safe(onInsert));
  bus.on('record.update', safe(onUpdate));
  bus.on('record.delete', safe(onDelete));
  bus.on('record.link', safe(onLink));
}

interface AuditRow {
  id: string;
  base_id: string;
  table_id: string | null;
  record_id: number | null;
  user_id: string | null;
  user_name: string | null;
  action: AuditEntry['action'];
  details: string | null;
  created_at: string;
}

const toEntry = (r: AuditRow): AuditEntry => ({
  id: r.id,
  baseId: r.base_id,
  tableId: r.table_id,
  recordId: r.record_id,
  userId: r.user_id,
  userName: r.user_name,
  action: r.action,
  details: json<unknown>(r.details, null),
  createdAt: r.created_at,
});

const SELECT = 'SELECT a.*, u.name AS user_name FROM nc_audit a LEFT JOIN nc_users u ON u.id = a.user_id';

export function recordAudit(tableId: string, recordId: number): AuditEntry[] {
  return (
    getDb().prepare(`${SELECT} WHERE a.table_id = ? AND a.record_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 500`).all(tableId, recordId) as AuditRow[]
  ).map(toEntry);
}

export async function auditRoutes(app: FastifyInstance) {
  initAudit();

  app.get<{ Params: { tableId: string; id: string } }>(
    '/api/v1/tables/:tableId/records/:id/audit',
    { schema: doc('Audit', 'History of one record, newest first') },
    async (req) => {
      requireTableRole(req, req.params.tableId, 'viewer');
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw notFound('Record');
      return recordAudit(req.params.tableId, id);
    },
  );

  app.get<{ Params: { baseId: string }; Querystring: { offset?: string; limit?: string } }>(
    '/api/v1/bases/:baseId/audit',
    { schema: doc('Audit', 'Audit log of a base, newest first (owner only)') },
    async (req) => {
      const { baseId } = req.params;
      requireBaseRole(req, baseId, 'owner');
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 25));
      const db = getDb();
      const total = (db.prepare('SELECT COUNT(*) AS n FROM nc_audit WHERE base_id = ?').get(baseId) as { n: number }).n;
      const list = (
        db.prepare(`${SELECT} WHERE a.base_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`).all(baseId, limit, offset) as AuditRow[]
      ).map(toEntry);
      return { list, pageInfo: { totalRows: total, offset, limit, isLastPage: offset + list.length >= total } };
    },
  );
}
