/** System status page. */
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUpUser } from './helpers.js';

let app: FastifyInstance;
let admin: Record<string, string>;

beforeAll(async () => {
  app = await createTestApp();
  admin = (await signUpUser(app)).headers;
});

describe('system status', () => {
  it('reports the app, PostgreSQL, secrets, directory sign-in and counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/status', headers: admin });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.build).toMatchObject({ version: expect.any(String), node_version: process.version });
    expect(s.runtime.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(s.postgres).toMatchObject({ ok: true, health: { connections: expect.any(Number), max_connections: expect.any(Number) } });
    expect(s.secrets.backend).toBe('local');
    expect(s.openbao.configured).toBe(false);
    expect(s.ldap).toMatchObject({ enabled: false });
    expect(s.entra).toMatchObject({ enabled: false });
    expect(s.inventory.users).toEqual({ local: 1, ldap: 0, entra: 0 });
    expect(s.settings.password_policy.min_length).toBe(12);
    expect(s.logs).toMatchObject({ counts: expect.any(Object), recent: expect.any(Array) });
  });
});
