/**
 * Organisation-wide access to DCIM/IPAM (not per base): every signed-in user can read; writes need `editor` or
 * `admin`. The role is assigned in SPA (the `roles` claim and the federation API, see auth/spa) and stored in
 * `nb_roles`; Inventory DB only enforces it.
 */
import type { FastifyRequest } from 'fastify';
import type { User } from '../../../shared/src/index.js';
import { requireUser } from '../auth/plugin.js';
import { getDb } from '../db/index.js';
import { forbidden } from '../errors.js';

export type NetboxRole = 'admin' | 'editor' | 'viewer';
export const NETBOX_ROLES: NetboxRole[] = ['admin', 'editor', 'viewer'];
const RANK: Record<NetboxRole, number> = { viewer: 1, editor: 2, admin: 3 };

export function getNetboxRole(userId: string): NetboxRole {
  const row = getDb().prepare('SELECT role FROM nb_roles WHERE user_id = ?').get(userId) as { role: NetboxRole } | undefined;
  return row?.role ?? 'viewer';
}

export function requireNetboxRole(req: FastifyRequest, min: NetboxRole): { user: User; role: NetboxRole } {
  const user = requireUser(req);
  const role = getNetboxRole(user.id);
  if (RANK[role] < RANK[min]) throw forbidden(`Requires the DCIM/IPAM ${min} role`);
  return { user, role };
}

/** Roles of the users (read-only: assigned in SPA). */
export function listRoles() {
  return getDb()
    .prepare("SELECT u.id user_id, u.email, u.name, u.username, COALESCE(r.role, 'viewer') role, u.disabled = 1 disabled FROM nc_users u LEFT JOIN nb_roles r ON r.user_id = u.id ORDER BY u.email")
    .all();
}
