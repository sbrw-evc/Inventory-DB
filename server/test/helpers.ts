import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { randomBytes } from 'node:crypto';
import { type DB, openDb, setDb } from '../src/db/index.js';
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
/** Signs up a new user and returns auth headers for `app.inject`. */
export async function signUpUser(app: FastifyInstance, email = `user${++n}@example.com`) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { email, password: 'Password-123!' } });
  const body = res.json() as { user: { id: string }; token: string };
  return { userId: body.user.id, headers: { authorization: `Bearer ${body.token}` } };
}
