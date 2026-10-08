import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Role, User } from '../../../shared/src/index.js';
import { ROLE_RANK } from '../../../shared/src/index.js';
import { getDb, newId, now } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-only-secret-change-me');

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: string;
}

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, createdAt: r.created_at });

export async function signUp(email: string, password: string, name?: string): Promise<User> {
  if (!/^\S+@\S+\.\S+$/.test(email)) throw badRequest('Invalid email');
  if (password.length < 8) throw badRequest('Password must be at least 8 characters');
  const db = getDb();
  if (db.prepare('SELECT 1 FROM nc_users WHERE email = ?').get(email)) throw conflict('Email already registered');
  const row: UserRow = {
    id: newId('usr'),
    email,
    name: name?.trim() || email.split('@')[0],
    password_hash: await bcrypt.hash(password, 10),
    created_at: now(),
  };
  db.prepare(
    'INSERT INTO nc_users (id, email, name, password_hash, created_at) VALUES (@id, @email, @name, @password_hash, @created_at)',
  ).run(row);
  return toUser(row);
}

export async function signIn(email: string, password: string): Promise<User> {
  const row = getDb().prepare('SELECT * FROM nc_users WHERE email = ?').get(email) as UserRow | undefined;
  if (!row || !(await bcrypt.compare(password, row.password_hash))) throw unauthorized('Invalid email or password');
  return toUser(row);
}

export function getUser(id: string): User {
  const row = getDb().prepare('SELECT * FROM nc_users WHERE id = ?').get(id) as UserRow | undefined;
  if (!row) throw notFound('User');
  return toUser(row);
}

export function findUserByEmail(email: string): User | null {
  const row = getDb().prepare('SELECT * FROM nc_users WHERE email = ?').get(email) as UserRow | undefined;
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
