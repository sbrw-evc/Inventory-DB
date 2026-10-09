/**
 * Directory sign-in settings (LDAP / AD and Entra ID) and the accounts they create. Settings live in `nc_settings`;
 * the LDAP bind password and the Entra client secret live in the secret store (OpenBao).
 */
import type { User } from '../../../shared/src/index.js';
import { getDb, newId, now } from '../db/index.js';
import { HttpError } from '../errors.js';
import { getSecret } from '../system/secrets.js';
import { readSetting } from '../system/settings.js';
import { defaultEntraConfig, normalizeEntra, type EntraConfig } from './entra.js';
import { defaultLdapConfig, type LdapConfig } from './ldap.js';

export type AccountSource = 'local' | 'ldap' | 'entra';

export const LDAP_KEY = 'directory.ldap';
export const ENTRA_KEY = 'directory.entra';
export const LDAP_SECRET = 'directory/ldap';
export const ENTRA_SECRET = 'directory/entra';

export function getLdapConfig(): LdapConfig {
  const stored = readSetting<Partial<LdapConfig>>(LDAP_KEY, {});
  return { ...defaultLdapConfig(stored.kind === 'openldap' ? 'openldap' : 'ad'), ...stored };
}

export function getEntraConfig(): EntraConfig {
  return { ...defaultEntraConfig(), ...readSetting<Partial<EntraConfig>>(ENTRA_KEY, {}) };
}

export const ldapBindPassword = async () => (await getSecret(LDAP_SECRET, 'bind_password')) ?? '';
export const entraClientSecret = async () => (await getSecret(ENTRA_SECRET, 'client_secret')) ?? '';

/** Entra ID as configured, or null when it is off or incomplete. */
export function activeEntra(): EntraConfig | null {
  const c = getEntraConfig();
  if (!c.enabled) return null;
  try {
    return normalizeEntra(c);
  } catch {
    return null;
  }
}

/** Users per source, for the settings and status pages. */
export function accountStats(source?: AccountSource) {
  const where = source ? 'WHERE u.source = ?' : '';
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) total, COUNT(*) FILTER (WHERE r.role = 'admin') admins, COUNT(*) FILTER (WHERE u.disabled = 1) disabled,
              MAX(u.last_sign_in_at) last_sign_in
       FROM nc_users u LEFT JOIN nb_roles r ON r.user_id = u.id ${where}`,
    )
    .get(...(source ? [source] : [])) as { total: number; admins: number; disabled: number; last_sign_in: string | null };
  return { total: row.total, admins: row.admins, disabled: row.disabled, last_sign_in: row.last_sign_in ?? undefined };
}

/** Admins who can still sign in with a password of their own: turning directory sign-in off must keep one. */
export function localAdmins(): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) n FROM nc_users u JOIN nb_roles r ON r.user_id = u.id WHERE r.role = 'admin' AND u.source = 'local' AND u.disabled = 0")
      .get() as { n: number }
  ).n;
}

export function usersBySource(): Record<AccountSource, number> {
  const rows = getDb().prepare('SELECT source, COUNT(*) n FROM nc_users GROUP BY source').all() as { source: AccountSource; n: number }[];
  const out: Record<AccountSource, number> = { local: 0, ldap: 0, entra: 0 };
  for (const r of rows) out[r.source] = r.n;
  return out;
}

interface ExternalIdentity {
  source: Exclude<AccountSource, 'local'>;
  externalId: string;
  username?: string;
  email: string;
  name: string;
  admin: boolean;
}

/**
 * Finds or creates the account of a directory user and applies the administrators group: members get the DCIM/IPAM
 * admin role; the role is taken back when they leave the group, unless it was given by hand or they are the last admin.
 */
export function provisionExternalUser(id: ExternalIdentity): User {
  const db = getDb();
  return db.transaction(() => {
    let row = db.prepare('SELECT id, disabled FROM nc_users WHERE source = ? AND external_id = ?').get(id.source, id.externalId) as
      | { id: string; disabled: number }
      | undefined;
    const sameEmail = db.prepare('SELECT id, source, external_id FROM nc_users WHERE lower(email) = lower(?)').get(id.email) as
      | { id: string; source: string; external_id: string | null }
      | undefined;
    if (!row && sameEmail) {
      // A directory account whose entry moved (new DN): keep the account. A local or other-source account is never taken over.
      if (sameEmail.source !== id.source)
        throw new HttpError(409, 'ACCOUNT_EXISTS', `An account with the email ${id.email} already exists and signs in another way`);
      db.prepare('UPDATE nc_users SET external_id = ? WHERE id = ?').run(id.externalId, sameEmail.id);
      row = { id: sameEmail.id, disabled: 0 };
    } else if (row && sameEmail && sameEmail.id !== row.id) {
      throw new HttpError(409, 'ACCOUNT_EXISTS', `An account with the email ${id.email} already exists`);
    }
    const ts = now();
    if (row) {
      if (row.disabled) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
      db.prepare('UPDATE nc_users SET email = ?, name = ?, username = ?, last_sign_in_at = ? WHERE id = ?').run(id.email, id.name, id.username ?? null, ts, row.id);
    } else {
      row = { id: newId('usr'), disabled: 0 };
      db.prepare(
        `INSERT INTO nc_users (id, email, name, password_hash, created_at, source, external_id, username, last_sign_in_at)
         VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`,
      ).run(row.id, id.email, id.name, ts, id.source, id.externalId, id.username ?? null, ts);
    }
    applyAdmin(row.id, id.source, id.admin);
    const user = db.prepare('SELECT id, email, name, created_at FROM nc_users WHERE id = ?').get(row.id) as { id: string; email: string; name: string; created_at: string };
    return { id: user.id, email: user.email, name: user.name, createdAt: user.created_at };
  })();
}

function applyAdmin(userId: string, source: string, admin: boolean) {
  const db = getDb();
  const current = (db.prepare('SELECT role FROM nb_roles WHERE user_id = ?').get(userId) as { role: string } | undefined)?.role;
  const granted = (db.prepare('SELECT admin_granted_by FROM nc_users WHERE id = ?').get(userId) as { admin_granted_by: string | null }).admin_granted_by;
  if (admin && current !== 'admin') {
    db.prepare("INSERT INTO nb_roles (user_id, role) VALUES (?, 'admin') ON CONFLICT (user_id) DO UPDATE SET role = 'admin'").run(userId);
    db.prepare('UPDATE nc_users SET admin_granted_by = ? WHERE id = ?').run(source, userId);
  } else if (!admin && current === 'admin' && granted === source) {
    const admins = (db.prepare("SELECT COUNT(*) n FROM nb_roles WHERE role = 'admin'").get() as { n: number }).n;
    if (admins > 1) {
      db.prepare("UPDATE nb_roles SET role = 'viewer' WHERE user_id = ?").run(userId);
      db.prepare('UPDATE nc_users SET admin_granted_by = NULL WHERE id = ?').run(userId);
    }
  }
}
