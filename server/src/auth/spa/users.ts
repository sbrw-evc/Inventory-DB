/**
 * Local user records synchronised from SPA. A user is bound to SPA's `sub` (`source = 'spa'`, `external_id = sub`);
 * a record from before SPA (local, LDAP, Entra ID, Umbrella…) is matched once by user name, then by e-mail, and
 * bound — so its ID, base memberships, ownership and audit history stay. The DCIM/IPAM role comes from SPA's `roles`.
 */
import type { User } from '../../../../shared/src/index.js';
import { getDb, newId, now } from '../../db/index.js';
import { NETBOX_ROLES, type NetboxRole } from '../../netbox/access.js';

/** The DCIM/IPAM role catalogue published to SPA. */
export const ROLE_CATALOGUE: { id: NetboxRole; name: string; description: string }[] = [
  { id: 'admin', name: 'Administrator', description: 'Everything in DCIM/IPAM, integrations and the settings of Inventory DB' },
  { id: 'editor', name: 'Editor', description: 'Creates and changes DCIM/IPAM objects' },
  { id: 'viewer', name: 'Viewer', description: 'Reads DCIM/IPAM; bases are shared by their owners' },
];
export const DEFAULT_ROLE: NetboxRole = 'viewer';
const RANK: Record<NetboxRole, number> = { viewer: 1, editor: 2, admin: 3 };

/** The highest DCIM/IPAM role among SPA's role IDs, or null when none of them is ours. */
export function roleFrom(roles: string[]): NetboxRole | null {
  let best: NetboxRole | null = null;
  for (const r of roles) if (NETBOX_ROLES.includes(r as NetboxRole) && (!best || RANK[r as NetboxRole] > RANK[best])) best = r as NetboxRole;
  return best;
}

export interface SpaPerson {
  sub: string;
  username: string;
  email: string;
  name: string;
  role: NetboxRole | null;
  disabled: boolean;
  /** Whether the e-mail may be used to find a record from before SPA (false when SPA says it is unverified). */
  emailTrusted?: boolean;
}

interface Row {
  id: string;
  email: string;
  name: string;
  created_at: string;
  disabled: number;
}

const COLS = 'id, email, name, created_at, disabled';

/** Ends every session and removes the API tokens of a user (disabled or gone in SPA). */
export function revokeAccess(userId: string) {
  const db = getDb();
  db.prepare('UPDATE nc_users SET sessions_revoked_at = ? WHERE id = ?').run(now(), userId);
  db.prepare('DELETE FROM nc_api_tokens WHERE user_id = ?').run(userId);
}

function disable(userId: string) {
  getDb().prepare('UPDATE nc_users SET disabled = 1 WHERE id = ?').run(userId);
  revokeAccess(userId);
}

/** A record from before SPA, matched once: by user name first, then by e-mail. */
function legacyMatch(p: SpaPerson): Row | undefined {
  const db = getDb();
  const unbound = "(source <> 'spa' OR external_id IS NULL)";
  if (p.username) {
    const r = db.prepare(`SELECT ${COLS} FROM nc_users WHERE ${unbound} AND lower(username) = lower(?) ORDER BY created_at LIMIT 1`).get(p.username) as Row | undefined;
    if (r) return r;
  }
  if (p.email && p.emailTrusted !== false)
    return db.prepare(`SELECT ${COLS} FROM nc_users WHERE ${unbound} AND lower(email) = lower(?) ORDER BY created_at LIMIT 1`).get(p.email) as Row | undefined;
  return undefined;
}

/** Creates or updates the record bound to `sub`; a disabled person (or one without a role here) is disabled. */
export function upsertSpaUser(p: SpaPerson): { user: User; created: boolean; matched: boolean; disabled: boolean; turnedOff: boolean } {
  const db = getDb();
  return db.transaction(() => {
    let row = db.prepare(`SELECT ${COLS} FROM nc_users WHERE source = 'spa' AND external_id = ?`).get(p.sub) as Row | undefined;
    let created = false;
    let matched = false;
    if (!row) {
      row = legacyMatch(p);
      if (row) {
        db.prepare("UPDATE nc_users SET source = 'spa', external_id = ? WHERE id = ?").run(p.sub, row.id);
        matched = true;
      } else {
        row = { id: newId('usr'), email: p.email, name: p.name, created_at: now(), disabled: 0 };
        db.prepare("INSERT INTO nc_users (id, email, name, created_at, source, external_id, username, disabled) VALUES (?, ?, ?, ?, 'spa', ?, ?, 0)").run(
          row.id,
          p.email,
          p.name,
          row.created_at,
          p.sub,
          p.username || null,
        );
        created = true;
      }
    }
    const off = p.disabled || !p.role;
    const name = p.name || p.username || p.email || p.sub;
    db.prepare('UPDATE nc_users SET email = ?, name = ?, username = ?, disabled = ? WHERE id = ?').run(p.email, name, p.username || null, off ? 1 : 0, row.id);
    if (off) {
      if (!row.disabled || created || matched) revokeAccess(row.id);
    } else db.prepare('INSERT INTO nb_roles (user_id, role) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET role = excluded.role').run(row.id, p.role);
    return { user: { id: row.id, email: p.email, name, createdAt: row.created_at }, created, matched, disabled: off, turnedOff: off && !created && !row.disabled };
  })();
}

/** Disables every enabled user that is not bound to one of `keep` (gone from SPA, or a record from before SPA). */
export function disableOthers(keep: string[]): number {
  const db = getDb();
  const set = new Set(keep);
  const rows = db.prepare("SELECT id, source, external_id FROM nc_users WHERE disabled = 0").all() as { id: string; source: string; external_id: string | null }[];
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (r.source === 'spa' && r.external_id && set.has(r.external_id)) continue;
      disable(r.id);
      n++;
    }
  })();
  return n;
}

export function touchSignIn(userId: string) {
  getDb().prepare('UPDATE nc_users SET last_sign_in_at = ? WHERE id = ?').run(now(), userId);
}

/** Users for the settings page (read-only: they are managed in SPA). */
export function listUsers() {
  return getDb()
    .prepare(
      `SELECT u.id, u.email, u.name, u.username, u.source, u.external_id, u.disabled, u.last_sign_in_at, u.created_at, COALESCE(r.role, 'viewer') AS role
       FROM nc_users u LEFT JOIN nb_roles r ON r.user_id = u.id ORDER BY u.disabled, lower(u.name), u.email`,
    )
    .all() as {
    id: string;
    email: string;
    name: string;
    username: string | null;
    source: string;
    external_id: string | null;
    disabled: number;
    last_sign_in_at: string | null;
    created_at: string;
    role: NetboxRole;
  }[];
}

export function userCounts() {
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) total, COUNT(*) FILTER (WHERE u.disabled = 0) active, COUNT(*) FILTER (WHERE u.disabled = 1) disabled,
              COUNT(*) FILTER (WHERE u.source = 'spa') bound, COUNT(*) FILTER (WHERE u.disabled = 0 AND r.role = 'admin') admins,
              MAX(u.last_sign_in_at) last_sign_in
       FROM nc_users u LEFT JOIN nb_roles r ON r.user_id = u.id`,
    )
    .get() as { total: number; active: number; disabled: number; bound: number; admins: number; last_sign_in: string | null };
  return {
    total: Number(r.total),
    active: Number(r.active),
    disabled: Number(r.disabled),
    bound: Number(r.bound),
    admins: Number(r.admins),
    last_sign_in: r.last_sign_in ?? undefined,
  };
}
