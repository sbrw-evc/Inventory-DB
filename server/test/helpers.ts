import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDb, setDb } from '../src/db/index.js';

/** Fresh in-memory database + app per test file. */
export async function createTestApp(): Promise<FastifyInstance> {
  setDb(openDb(':memory:'));
  return buildApp({ webDist: '/nonexistent' });
}

let n = 0;
/** Signs up a new user and returns auth headers for `app.inject`. */
export async function signUpUser(app: FastifyInstance, email = `user${++n}@example.com`) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { email, password: 'password123' } });
  const body = res.json() as { user: { id: string }; token: string };
  return { userId: body.user.id, headers: { authorization: `Bearer ${body.token}` } };
}
