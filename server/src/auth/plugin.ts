import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Role, User } from '../../../shared/src/index.js';
import { getDb } from '../db/index.js';
import { notFound, unauthorized } from '../errors.js';
import { assertBaseRole, getUser, userIdForApiToken, verifyJwt } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

/**
 * Resolves the caller from `Authorization: Bearer <jwt>`, `xc-auth: <jwt>` or `xc-token: <api token>`.
 * Routes then call `requireUser(req)` / `requireBaseRole(...)`.
 */
export async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    let userId: string | null = null;
    const apiToken = req.headers['xc-token'];
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? (req.headers['xc-auth'] as string | undefined);
    if (typeof apiToken === 'string' && apiToken) userId = userIdForApiToken(apiToken);
    else if (bearer) userId = await verifyJwt(bearer);
    if (userId) {
      try {
        req.user = getUser(userId);
      } catch {
        req.user = null;
      }
    }
  });
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireBaseRole(req: FastifyRequest, baseId: string, min: Role): Role {
  return assertBaseRole(baseId, requireUser(req).id, min);
}

/** Look up the base owning a table, then check the role. Returns the baseId. */
export function requireTableRole(req: FastifyRequest, tableId: string, min: Role): string {
  const row = getDb().prepare('SELECT base_id FROM nc_tables WHERE id = ?').get(tableId) as { base_id: string } | undefined;
  if (!row) throw notFound('Table');
  requireBaseRole(req, row.base_id, min);
  return row.base_id;
}

/** Like requireTableRole, but returns the caller's role too (for field-level permissions). */
export function requireTableAccess(req: FastifyRequest, tableId: string, min: Role): { baseId: string; role: Role } {
  const row = getDb().prepare('SELECT base_id FROM nc_tables WHERE id = ?').get(tableId) as { base_id: string } | undefined;
  if (!row) throw notFound('Table');
  return { baseId: row.base_id, role: requireBaseRole(req, row.base_id, min) };
}

export function requireViewRole(req: FastifyRequest, viewId: string, min: Role): { baseId: string; tableId: string } {
  const row = getDb()
    .prepare('SELECT t.base_id, v.table_id FROM nc_views v JOIN nc_tables t ON t.id = v.table_id WHERE v.id = ?')
    .get(viewId) as { base_id: string; table_id: string } | undefined;
  if (!row) throw notFound('View');
  requireBaseRole(req, row.base_id, min);
  return { baseId: row.base_id, tableId: row.table_id };
}

export function requireColumnRole(req: FastifyRequest, columnId: string, min: Role): { baseId: string; tableId: string } {
  const row = getDb()
    .prepare('SELECT t.base_id, c.table_id FROM nc_columns c JOIN nc_tables t ON t.id = c.table_id WHERE c.id = ?')
    .get(columnId) as { base_id: string; table_id: string } | undefined;
  if (!row) throw notFound('Column');
  requireBaseRole(req, row.base_id, min);
  return { baseId: row.base_id, tableId: row.table_id };
}
