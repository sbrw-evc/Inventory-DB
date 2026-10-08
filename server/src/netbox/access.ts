/**
 * Organisation-wide access to DCIM/IPAM (not per base): every signed-in user can read; writes need `editor` or
 * `admin`. While nobody is admin yet, the first user who writes (or calls GET /netbox/me) becomes admin.
 */
import type { FastifyRequest } from 'fastify';
import type { User } from '../../../shared/src/index.js';
import { requireUser } from '../auth/plugin.js';
import { getDb } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';

export type NetboxRole = 'admin' | 'editor' | 'viewer';
export const NETBOX_ROLES: NetboxRole[] = ['admin', 'editor', 'viewer'];
const RANK: Record<NetboxRole, number> = { viewer: 1, editor: 2, admin: 3 };

export function getNetboxRole(userId: string): NetboxRole {
  const row = getDb().prepare('SELECT role FROM nb_roles WHERE user_id = ?').get(userId) as { role: NetboxRole } | undefined;
  return row?.role ?? 'viewer';
}

/** Makes `user` admin when no admin exists yet. */
export function bootstrapAdmin(user: User) {
  const db = getDb();
  const hasAdmin = db.prepare("SELECT 1 FROM nb_roles WHERE role = 'admin' LIMIT 1").get();
  if (!hasAdmin) db.prepare("INSERT INTO nb_roles (user_id, role) VALUES (?, 'admin') ON CONFLICT(user_id) DO UPDATE SET role = 'admin'").run(user.id);
}

export function requireNetboxRole(req: FastifyRequest, min: NetboxRole): { user: User; role: NetboxRole } {
  const user = requireUser(req);
  if (min !== 'viewer') bootstrapAdmin(user);
  const role = getNetboxRole(user.id);
  if (RANK[role] < RANK[min]) throw forbidden(`Requires the DCIM/IPAM ${min} role`);
  return { user, role };
}

export function listRoles() {
  return getDb()
    .prepare("SELECT u.id user_id, u.email, u.name, COALESCE(r.role, 'viewer') role FROM nc_users u LEFT JOIN nb_roles r ON r.user_id = u.id ORDER BY u.email")
    .all();
}

export function setRole(userIdOrEmail: string, role: string) {
  if (!NETBOX_ROLES.includes(role as NetboxRole)) throw badRequest('Invalid role', { role: [`Must be one of ${NETBOX_ROLES.join(', ')}.`] });
  const db = getDb();
  const user = db.prepare('SELECT id, email, name FROM nc_users WHERE id = ? OR email = ?').get(userIdOrEmail, userIdOrEmail) as
    | { id: string; email: string; name: string }
    | undefined;
  if (!user) throw notFound('User');
  if (role !== 'admin' && getNetboxRole(user.id) === 'admin') {
    const admins = (db.prepare("SELECT COUNT(*) n FROM nb_roles WHERE role = 'admin'").get() as { n: number }).n;
    if (admins <= 1) throw conflict('The last DCIM/IPAM admin cannot be demoted');
  }
  db.prepare('INSERT INTO nb_roles (user_id, role) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role').run(user.id, role);
  return { user_id: user.id, email: user.email, name: user.name, role };
}
