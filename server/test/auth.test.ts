import { describe, expect, it } from 'vitest';
import { createTestApp, signUpUser } from './helpers.js';

describe('auth', () => {
  it('signs up, signs in and returns the current user', async () => {
    const app = await createTestApp();
    const { headers } = await signUpUser(app, 'a@example.com');
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });
    expect(me.json().user.email).toBe('a@example.com');

    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/signin', payload: { email: 'a@example.com', password: 'nope' } });
    expect(bad.statusCode).toBe(401);

    const anon = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(anon.statusCode).toBe(401);
  });
});
