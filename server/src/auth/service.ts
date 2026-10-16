import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Role, User } from '../../../shared/src/index.js';
import { ROLE_RANK } from '../../../shared/src/index.js';
import { getDb, newId, now } from '../db/index.js';
import { forbidden, notFound, unauthorized } from '../errors.js';

let signingKey: Uint8Array | null = null;
const secret = () => signingKey ?? new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-only-secret-change-me');

/** The key that signs sessions (from JWT_SECRET or the secret store; see system/init.ts). */
export function setJwtSecret(value: string | null) {
  signingKey = value ? new TextEncoder().encode(value) : null;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: string;
  source: string;
  username: string | null;
  disabled: number;
  sessions_revoked_at: string | null;
}

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, createdAt: r.created_at });

/** Disabled accounts (by SPA) lose their sessions and API tokens. */
export function isDisabled(userId: string): boolean {
  const row = getDb().prepare('SELECT disabled FROM nc_users WHERE id = ?').get(userId) as { disabled: number } | undefined;
  return !row || !!row.disabled;
}

/** Whether a session issued at `iat` (seconds) still holds: the account is enabled and its sessions were not revoked since (the second of the revocation counts as before it). */
export function sessionValid(userId: string, iat: number | undefined): boolean {
  const row = getDb().prepare('SELECT disabled, sessions_revoked_at FROM nc_users WHERE id = ?').get(userId) as Pick<UserRow, 'disabled' | 'sessions_revoked_at'> | undefined;
  if (!row || row.disabled) return false;
  if (row.sessions_revoked_at && (iat ?? 0) <= Math.floor(Date.parse(row.sessions_revoked_at) / 1000)) return false;
  return true;
}

/** How the account is known: SPA's user ID and user name. */
export function accountInfo(userId: string) {
  const row = getDb().prepare('SELECT source, external_id, username FROM nc_users WHERE id = ?').get(userId) as
    | { source: string; external_id: string | null; username: string | null }
    | undefined;
  return { source: row?.source ?? 'spa', spaId: row?.source === 'spa' ? row.external_id : null, username: row?.username ?? null };
}

export function getUser(id: string): User {
  const row = getDb().prepare('SELECT * FROM nc_users WHERE id = ?').get(id) as UserRow | undefined;
  if (!row) throw notFound('User');
  return toUser(row);
}

/** For invitations to a base: an enabled user with this e-mail (or SPA user name). */
export function findUserByEmail(email: string): User | null {
  const row = getDb()
    .prepare('SELECT * FROM nc_users WHERE (lower(email) = lower(?) OR lower(username) = lower(?)) ORDER BY disabled, created_at LIMIT 1')
    .get(email, email) as UserRow | undefined;
  return row ? toUser(row) : null;
}

/** Hours a session lasts (SESSION_HOURS, 12 by default); SPA can end it sooner by disabling the person. */
const sessionHours = () => {
  const h = Number(process.env.SESSION_HOURS ?? 12);
  return Number.isFinite(h) && h > 0 ? h : 12;
};

/** Inventory DB's own session, started after the SPA callback. */
export async function issueJwt(user: User): Promise<string> {
  return new SignJWT({ email: user.email, typ: 'session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${Math.round(sessionHours() * 3600)}s`)
    .sign(secret());
}

export async function verifyJwt(token: string): Promise<{ sub: string; iat?: number } | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    // Signed values (the SPA sign-in state) share the key but are not sessions.
    if (payload.typ !== 'session' || !payload.sub) return null;
    return { sub: payload.sub, iat: payload.iat };
  } catch {
    return null;
  }
}

/** Short-lived signed values (the SPA sign-in state). */
export async function signValue(payload: Record<string, unknown>, ttl: string): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(ttl).sign(secret());
}

export async function verifyValue<T>(token: string): Promise<T | null> {
  try {
    return (await jwtVerify(token, secret())).payload as T;
  } catch {
    return null;
  }
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function createApiToken(userId: string, description: string) {
  const token = `nc_${randomBytes(24).toString('base64url')}`;
  const row = { id: newId('tok'), user_id: userId, description, token_hash: hashToken(token), created_at: now() };
  getDb()
    .prepare('INSERT INTO nc_api_tokens (id, user_id, description, token_hash, created_at) VALUES (@id, @user_id, @description, @token_hash, @created_at)')
    .run(row);
  return { id: row.id, description, token, createdAt: row.created_at };
}

/** The owner of an API token, or null when there is no such token or it is suspended (its owner is disabled in SPA). */
export function userIdForApiToken(token: string): string | null {
  const row = getDb()
    .prepare('SELECT t.user_id, t.suspended_at, u.disabled FROM nc_api_tokens t JOIN nc_users u ON u.id = t.user_id WHERE t.token_hash = ?')
    .get(hashToken(token)) as { user_id: string; suspended_at: string | null; disabled: number } | undefined;
  if (!row || row.suspended_at || row.disabled) return null;
  return row.user_id;
}

export function getBaseRole(baseId: string, userId: string): Role | null {
  const row = getDb().prepare('SELECT role FROM nc_base_members WHERE base_id = ? AND user_id = ?').get(baseId, userId) as
    | { role: Role }
    | undefined;
  return row?.role ?? null;
}

/** Throws 404 if the user is not a member (hide existence), 403 if their role is too low. */
export function assertBaseRole(baseId: string, userId: string | undefined | null, min: Role): Role {
  if (!userId) throw unauthorized();
  const role = getBaseRole(baseId, userId);
  if (!role) throw notFound('Base');
  if (ROLE_RANK[role] < ROLE_RANK[min]) throw forbidden(`Requires ${min} role`);
  return role;
}
