/** System status page. */
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signInUser } from './helpers.js';

let app: FastifyInstance;
let admin: Record<string, string>;

beforeAll(async () => {
  app = await createTestApp();
  admin = (await signInUser(app)).headers;
});

describe('system status', () => {
  it('reports the app, PostgreSQL, secrets, the SPA connection and counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/status', headers: admin });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.build).toMatchObject({ version: expect.any(String), node_version: process.version });
    expect(s.runtime.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(s.postgres).toMatchObject({ ok: true, health: { connections: expect.any(Number), max_connections: expect.any(Number) } });
    expect(s.secrets.backend).toBe('local');
    expect(s.openbao.configured).toBe(false);
    expect(s.spa).toMatchObject({ connected: false, ok: false });
    expect(s.ldap).toBeUndefined();
    expect(s.settings).toBeUndefined();
    expect(s.inventory).toMatchObject({ users: 1, admins: 1, disabled_users: 0 });
    expect(s.logs).toMatchObject({ counts: expect.any(Object), recent: expect.any(Array) });
  });
});
