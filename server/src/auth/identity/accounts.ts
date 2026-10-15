/**
 * Accounts made by Umbrella Identity: Google, Apple, OpenID Connect and the Umbrella hub. An account is bound to the
 * provider's subject (`source`, `external_id`); its DCIM/IPAM role is set from the provider or the hub's mapping.
 */
import type { User } from '../../../../shared/src/index.js';
import { getDb, newId, now } from '../../db/index.js';
import { HttpError } from '../../errors.js';
import type { NetboxRole } from '../../netbox/access.js';

export type IdentitySource = 'google' | 'apple' | 'oidc' | 'umbrella';

export interface Account {
  source: IdentitySource;
  externalId: string;
  email: string;
  name: string;
  username?: string;
  role: NetboxRole;
  disabled?: boolean;
}

interface Row {
  id: string;
  email: string;
  name: string;
  created_at: string;
  source: string;
  disabled: number;
}

const toUser = (r: Row): User => ({ id: r.id, email: r.email, name: r.name, createdAt: r.created_at });

/** The account bound to (source, external ID), or null. */
export function accountByExternal(source: IdentitySource, externalId: string): (User & { disabled: boolean }) | null {
  const r = getDb().prepare('SELECT id, email, name, created_at, source, disabled FROM nc_users WHERE source = ? AND external_id = ?').get(source, externalId) as
    | Row
    | undefined;
  return r ? { ...toUser(r), disabled: !!r.disabled } : null;
}

export function accountByEmail(email: string): (User & { source: string; disabled: boolean }) | null {
  const r = getDb().prepare('SELECT id, email, name, created_at, source, disabled FROM nc_users WHERE lower(email) = lower(?)').get(email) as Row | undefined;
  return r ? { ...toUser(r), source: r.source, disabled: !!r.disabled } : null;
}

const isAdmin = (userId: string) => (getDb().prepare('SELECT role FROM nb_roles WHERE user_id = ?').get(userId) as { role: string } | undefined)?.role === 'admin';

function setRole(userId: string, role: NetboxRole) {
  const db = getDb();
  if (role !== 'admin' && isAdmin(userId)) {
    const admins = (db.prepare("SELECT COUNT(*) n FROM nb_roles WHERE role = 'admin'").get() as { n: number }).n;
    if (admins <= 1) return; // the last admin is never demoted
  }
  db.prepare('INSERT INTO nb_roles (user_id, role) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET role = excluded.role').run(userId, role);
}

/**
 * Creates or refreshes the account. `link` lists sources whose account with the same e-mail is taken over (bound to
 * the provider); local administrators are never taken over, so they keep their password.
 */
export function upsertAccount(a: Account, link: string[] = []): { user: User; created: boolean } {
  const db = getDb();
  return db.transaction(() => {
    const ts = now();
    let row = db.prepare('SELECT id, email, name, created_at, source, disabled FROM nc_users WHERE source = ? AND external_id = ?').get(a.source, a.externalId) as
      | Row
      | undefined;
    let created = false;
    if (!row) {
      const same = db.prepare('SELECT id, email, name, created_at, source, disabled FROM nc_users WHERE lower(email) = lower(?)').get(a.email) as Row | undefined;
      if (same) {
        if (!link.includes(same.source) || (same.source === 'local' && isAdmin(same.id)))
          throw new HttpError(409, 'ACCOUNT_EXISTS', `An account with the email ${a.email} already exists and signs in another way`);
        db.prepare("UPDATE nc_users SET source = ?, external_id = ?, password_hash = '' WHERE id = ?").run(a.source, a.externalId, same.id);
        row = same;
      } else {
        row = { id: newId('usr'), email: a.email, name: a.name, created_at: ts, source: a.source, disabled: 0 };
        db.prepare(
          `INSERT INTO nc_users (id, email, name, password_hash, created_at, source, external_id, username, disabled)
           VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`,
        ).run(row.id, a.email, a.name, ts, a.source, a.externalId, a.username ?? null, a.disabled ? 1 : 0);
        created = true;
      }
    }
    db.prepare('UPDATE nc_users SET email = ?, name = ?, username = ?, disabled = ? WHERE id = ?').run(a.email, a.name || a.email, a.username ?? null, a.disabled ? 1 : 0, row.id);
    if (!a.disabled) setRole(row.id, a.role);
    return { user: { id: row.id, email: a.email, name: a.name || a.email, createdAt: row.created_at }, created };
  })();
}

/** Disables the accounts of `source` whose external ID is not in `keep`; returns how many. */
export function disableMissing(source: IdentitySource, keep: string[]): number {
  const db = getDb();
  const rows = db.prepare('SELECT id, external_id FROM nc_users WHERE source = ? AND disabled = 0').all(source) as { id: string; external_id: string }[];
  const set = new Set(keep);
  let n = 0;
  for (const r of rows) {
    if (set.has(r.external_id)) continue;
    db.prepare('UPDATE nc_users SET disabled = 1 WHERE id = ?').run(r.id);
    n++;
  }
  return n;
}

export function touchSignIn(userId: string) {
  getDb().prepare('UPDATE nc_users SET last_sign_in_at = ? WHERE id = ?').run(now(), userId);
}
