import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BaseMember } from '../../../shared/src/index.js';
import { requireBaseRole, requireUser } from '../auth/plugin.js';
import { findUserByEmail } from '../auth/service.js';
import { getDb } from '../db/index.js';
import { conflict, HttpError, notFound } from '../errors.js';
import { doc } from './docs.js';

const role = z.enum(['owner', 'editor', 'commenter', 'viewer']);

export function listMembers(baseId: string): BaseMember[] {
  return getDb()
    .prepare(
      `SELECT u.id AS "userId", u.email, u.name, m.role FROM nc_base_members m
       JOIN nc_users u ON u.id = m.user_id WHERE m.base_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'commenter' THEN 2 ELSE 3 END, u.email`,
    )
    .all(baseId) as BaseMember[];
}

function getMember(baseId: string, userId: string): BaseMember {
  const m = listMembers(baseId).find((x) => x.userId === userId);
  if (!m) throw notFound('Member');
  return m;
}

const ownerCount = (baseId: string) =>
  (getDb().prepare("SELECT COUNT(*) AS n FROM nc_base_members WHERE base_id = ? AND role = 'owner'").get(baseId) as { n: number }).n;

function assertNotLastOwner(baseId: string, userId: string) {
  const m = getMember(baseId, userId);
  if (m.role === 'owner' && ownerCount(baseId) <= 1) {
    throw new HttpError(400, 'LAST_OWNER', 'A base must keep at least one owner');
  }
}

export async function memberRoutes(app: FastifyInstance) {
  app.get<{ Params: { baseId: string } }>(
    '/api/v1/bases/:baseId/members',
    { schema: doc('Members', 'List base members') },
    async (req) => {
      requireBaseRole(req, req.params.baseId, 'viewer');
      return listMembers(req.params.baseId);
    },
  );

  app.post<{ Params: { baseId: string } }>(
    '/api/v1/bases/:baseId/members',
    { schema: doc('Members', 'Invite an existing user by email') },
    async (req) => {
      const { baseId } = req.params;
      requireBaseRole(req, baseId, 'owner');
      const body = z.object({ email: z.string().trim().min(1), role }).parse(req.body);
      const user = findUserByEmail(body.email);
      if (!user) throw notFound('User');
      const db = getDb();
      if (db.prepare('SELECT 1 FROM nc_base_members WHERE base_id = ? AND user_id = ?').get(baseId, user.id)) {
        throw conflict('User is already a member of this base');
      }
      db.prepare('INSERT INTO nc_base_members (base_id, user_id, role) VALUES (?, ?, ?)').run(baseId, user.id, body.role);
      return getMember(baseId, user.id);
    },
  );

  app.patch<{ Params: { baseId: string; userId: string } }>(
    '/api/v1/bases/:baseId/members/:userId',
    { schema: doc('Members', "Change a member's role") },
    async (req) => {
      const { baseId, userId } = req.params;
      requireBaseRole(req, baseId, 'owner');
      const body = z.object({ role }).parse(req.body);
      if (body.role !== 'owner') assertNotLastOwner(baseId, userId);
      else getMember(baseId, userId);
      getDb().prepare('UPDATE nc_base_members SET role = ? WHERE base_id = ? AND user_id = ?').run(body.role, baseId, userId);
      return getMember(baseId, userId);
    },
  );

  app.delete<{ Params: { baseId: string; userId: string } }>(
    '/api/v1/bases/:baseId/members/:userId',
    { schema: doc('Members', 'Remove a member (members may also remove themselves)') },
    async (req) => {
      const { baseId, userId } = req.params;
      const me = requireUser(req);
      requireBaseRole(req, baseId, me.id === userId ? 'viewer' : 'owner');
      assertNotLastOwner(baseId, userId);
      getDb().prepare('DELETE FROM nc_base_members WHERE base_id = ? AND user_id = ?').run(baseId, userId);
      return { ok: true };
    },
  );
}
