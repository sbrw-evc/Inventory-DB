import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Role, User } from '../../../shared/src/index.js';
import { ROLE_RANK } from '../../../shared/src/index.js';
import { getDb, newId, now } from '../db/index.js';
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { logEvent } from '../system/logbuf.js';
import { getLdapConfig, ldapBindPassword, provisionExternalUser } from './directory.js';
import { ldapAuthenticate, normalizeLdap } from './ldap.js';
import { assertPasswordAllowed, isExpired } from './policy.js';

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
  password_hash: string;
  created_at: string;
  source: 'local' | 'ldap' | 'entra';
  username: string | null;
  disabled: number;
  password_changed_at: string | null;
}

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, createdAt: r.created_at });

export async function signUp(email: string, password: string, name?: string): Promise<User> {
  if (!/^\S+@\S+\.\S+$/.test(email)) throw badRequest('Invalid email');
  assertPasswordAllowed(password, email);
  const db = getDb();
  if (db.prepare('SELECT 1 FROM nc_users WHERE lower(email) = lower(?)').get(email)) throw conflict('Email already registered');
  const ts = now();
  const row = {
    id: newId('usr'),
    email,
    name: name?.trim() || email.split('@')[0],
    password_hash: await bcrypt.hash(password, 10),
    created_at: ts,
  };
  db.prepare(
    `INSERT INTO nc_users (id, email, name, password_hash, created_at, password_changed_at, last_sign_in_at)
     VALUES (@id, @email, @name, @password_hash, @created_at, @created_at, @created_at)`,
  ).run(row);
  return { id: row.id, email: row.email, name: row.name, createdAt: row.created_at };
}

const passwordExpired = () =>
  new HttpError(403, 'PASSWORD_EXPIRED', 'Your password has expired. Choose a new one.');

/** A local account with this login (email) and password, or null when the password is wrong. */
async function localAccount(login: string, password: string): Promise<UserRow | null> {
  const row = getDb().prepare("SELECT * FROM nc_users WHERE source = 'local' AND lower(email) = lower(?)").get(login) as UserRow | undefined;
  if (!row || !row.password_hash || !(await bcrypt.compare(password, row.password_hash))) return null;
  return row;
}

/**
 * Local accounts first, then LDAP / AD when it is on. `login` is an email for local accounts and the directory user
 * name (or user@domain) for LDAP.
 */
export async function signIn(login: string, password: string): Promise<User> {
  const local = await localAccount(login, password);
  if (local) {
    if (local.disabled) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
    if (isExpired(local.password_changed_at)) throw passwordExpired();
    getDb().prepare('UPDATE nc_users SET last_sign_in_at = ? WHERE id = ?').run(now(), local.id);
    return toUser(local);
  }
  const ldap = getLdapConfig();
  if (ldap.enabled) {
    let identity;
    try {
      identity = await ldapAuthenticate(normalizeLdap(ldap), await ldapBindPassword(), login.trim(), password);
    } catch (e) {
      logEvent('error', 'LDAP sign-in failed', { login, error: (e as Error).message });
      throw new HttpError(503, 'DIRECTORY_UNAVAILABLE', `The directory could not check the password: ${(e as Error).message}`);
    }
    if (identity)
      return provisionExternalUser({ source: 'ldap', externalId: identity.dn.toLowerCase(), username: identity.username, email: identity.email, name: identity.name, admin: identity.admin });
  }
  throw unauthorized(ldap.enabled ? 'Invalid login or password' : 'Invalid email or password');
}

/** Sets a new password for a local account after checking the current one (also used when it has expired). */
export async function changePassword(login: string, current: string, next: string): Promise<User> {
  const row = await localAccount(login, current);
  if (!row) throw unauthorized('Invalid email or password');
  if (row.disabled) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
  assertPasswordAllowed(next, row.email);
  if (await bcrypt.compare(next, row.password_hash)) throw new HttpError(400, 'PASSWORD_REUSED', 'The new password must differ from the current one');
  const ts = now();
  getDb().prepare('UPDATE nc_users SET password_hash = ?, password_changed_at = ?, last_sign_in_at = ? WHERE id = ?').run(await bcrypt.hash(next, 10), ts, ts, row.id);
  return toUser(row);
}

/** How the account signs in and when its password expires, for the web app. */
export function accountInfo(userId: string) {
  const row = getDb().prepare('SELECT source, password_changed_at FROM nc_users WHERE id = ?').get(userId) as Pick<UserRow, 'source' | 'password_changed_at'> | undefined;
  return { source: row?.source ?? 'local', passwordChangedAt: row?.password_changed_at ?? null };
}

/** Disabled accounts lose their sessions and API tokens. */
export function isDisabled(userId: string): boolean {
  const row = getDb().prepare('SELECT disabled FROM nc_users WHERE id = ?').get(userId) as { disabled: number } | undefined;
  return !row || !!row.disabled;
}

export function getUser(id: string): User {
  const row = getDb().prepare('SELECT * FROM nc_users WHERE id = ?').get(id) as UserRow | undefined;
  if (!row) throw notFound('User');
  return toUser(row);
}

export function findUserByEmail(email: string): User | null {
  const row = getDb().prepare('SELECT * FROM nc_users WHERE lower(email) = lower(?)').get(email) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export async function issueJwt(user: User): Promise<string> {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret());
}

export async function verifyJwt(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/** Short-lived signed values (the Entra ID sign-in state). */
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

export function userIdForApiToken(token: string): string | null {
  const row = getDb().prepare('SELECT user_id FROM nc_api_tokens WHERE token_hash = ?').get(hashToken(token)) as
    | { user_id: string }
    | undefined;
  return row?.user_id ?? null;
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
