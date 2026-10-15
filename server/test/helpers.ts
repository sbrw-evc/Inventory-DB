import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { randomBytes } from 'node:crypto';
import { issueJwt } from '../src/auth/service.js';
import { upsertSpaUser } from '../src/auth/spa/users.js';
import { type DB, getDb, openDb, setDb } from '../src/db/index.js';
import type { NetboxRole } from '../src/netbox/access.js';
import { TEST_DATABASE_URL, TEST_SCHEMA_PREFIX } from './db-env.js';

/** A fresh, empty database (its own schema) with all migrations applied. */
export function openTestDb(): DB {
  return openDb(TEST_DATABASE_URL, { schema: `${TEST_SCHEMA_PREFIX}${randomBytes(6).toString('hex')}` });
}

/** Fresh database + app per test file. */
export async function createTestApp(): Promise<FastifyInstance> {
  setDb(openTestDb());
  return buildApp({ webDist: '/nonexistent' });
}

let n = 0;
/**
 * A person SPA lets in: creates the user record the way the SPA synchronization does (bound to an SPA user ID) and
 * starts an Inventory DB session for it. The DCIM/IPAM role is the one SPA would give: `role`, else admin for the
 * first user of the database and viewer for the others.
 */
export async function signInUser(_app: FastifyInstance, email = `user${++n}@example.com`, role?: NetboxRole) {
  const hasAdmin = getDb().prepare("SELECT 1 FROM nb_roles WHERE role = 'admin' LIMIT 1").get();
  const { user } = upsertSpaUser({
    sub: `spa-${email.toLowerCase()}`,
    username: email.split('@')[0],
    email,
    name: email.split('@')[0],
    role: role ?? (hasAdmin ? 'viewer' : 'admin'),
    disabled: false,
  });
  return { userId: user.id, headers: { authorization: `Bearer ${await issueJwt(user)}` } };
}

/** Sets the DCIM/IPAM role of a user as an SPA synchronization would. */
export function grantRole(userId: string, role: NetboxRole) {
  getDb().prepare('INSERT INTO nb_roles (user_id, role) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET role = excluded.role').run(userId, role);
}
