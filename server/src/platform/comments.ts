import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Comment } from '../../../shared/src/index.js';
import { requireTableRole, requireUser } from '../auth/plugin.js';
import { getBaseRole } from '../auth/service.js';
import { dataTableName, getDb, newId, now, q } from '../db/index.js';
import { forbidden, notFound } from '../errors.js';
import { doc } from './docs.js';

const recordId = (raw: string) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw notFound('Record');
  return n;
};

/** Throws 404 when the record does not exist in the table's physical storage. */
export function assertRecordExists(tableId: string, id: number) {
  try {
    if (getDb().prepare(`SELECT 1 FROM ${q(dataTableName(tableId))} WHERE id = ?`).get(id)) return;
  } catch {
    /* missing physical table */
  }
  throw notFound('Record');
}

const SELECT = `SELECT c.id, c.table_id AS tableId, c.record_id AS recordId, c.user_id AS userId,
  COALESCE(u.name, '') AS userName, c.body, c.created_at AS createdAt
  FROM nc_comments c LEFT JOIN nc_users u ON u.id = c.user_id`;

export function listComments(tableId: string, id: number): Comment[] {
  return getDb().prepare(`${SELECT} WHERE c.table_id = ? AND c.record_id = ? ORDER BY c.created_at, c.rowid`).all(tableId, id) as Comment[];
}

export async function commentRoutes(app: FastifyInstance) {
  app.get<{ Params: { tableId: string; id: string } }>(
    '/api/v1/tables/:tableId/records/:id/comments',
    { schema: doc('Comments', 'List comments on a record (oldest first)') },
    async (req) => {
      requireTableRole(req, req.params.tableId, 'viewer');
      return listComments(req.params.tableId, recordId(req.params.id));
    },
  );

  app.post<{ Params: { tableId: string; id: string } }>(
    '/api/v1/tables/:tableId/records/:id/comments',
    { schema: doc('Comments', 'Add a comment to a record') },
    async (req) => {
      const { tableId } = req.params;
      requireTableRole(req, tableId, 'commenter');
      const user = requireUser(req);
      const id = recordId(req.params.id);
      const body = z.object({ body: z.string().trim().min(1).max(10000) }).parse(req.body);
      assertRecordExists(tableId, id);
      const cid = newId('cmt');
      getDb()
        .prepare('INSERT INTO nc_comments (id, table_id, record_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(cid, tableId, id, user.id, body.body, now());
      return getDb().prepare(`${SELECT} WHERE c.id = ?`).get(cid) as Comment;
    },
  );

  app.delete<{ Params: { commentId: string } }>(
    '/api/v1/comments/:commentId',
    { schema: doc('Comments', 'Delete a comment (author or base owner)') },
    async (req) => {
      const user = requireUser(req);
      const row = getDb()
        .prepare('SELECT c.user_id, t.base_id FROM nc_comments c JOIN nc_tables t ON t.id = c.table_id WHERE c.id = ?')
        .get(req.params.commentId) as { user_id: string; base_id: string } | undefined;
      if (!row) throw notFound('Comment');
      const role = getBaseRole(row.base_id, user.id);
      if (!role) throw notFound('Comment');
      if (row.user_id !== user.id && role !== 'owner') throw forbidden('Only the author or a base owner can delete this comment');
      getDb().prepare('DELETE FROM nc_comments WHERE id = ?').run(req.params.commentId);
      return { ok: true };
    },
  );
}
