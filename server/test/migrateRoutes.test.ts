import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../shared/src/index.js';
import { MOCK_TOKEN, startMockNocoDB, type MockNocoDB } from './migrateNocodbMock.js';

// In-memory jobs store so this test doesn't depend on the platform module.
const jobs = vi.hoisted(() => new Map<string, Job>());
vi.mock('../src/platform/jobs.js', () => ({
  createJob: (_userId: string, kind: Job['kind']): Job => {
    const job: Job = { id: `job${jobs.size + 1}`, kind, status: 'queued', progress: 0, message: '', log: [], createdAt: new Date().toISOString() };
    jobs.set(job.id, job);
    return job;
  },
  updateJob: (id: string, patch: Partial<Job> & { appendLog?: string }) => {
    const job = jobs.get(id)!;
    const { appendLog, ...rest } = patch;
    Object.assign(job, rest);
    if (appendLog) job.log.push(appendLog);
    return job;
  },
  getJob: (id: string) => jobs.get(id)!,
}));

const { createTestApp, signUpUser } = await import('./helpers.js');

let mock: MockNocoDB;
beforeAll(async () => {
  mock = await startMockNocoDB({ workspaces: false });
});
afterAll(async () => mock.close());

describe('NocoDB migration routes', () => {
  it('lists NocoDB bases and validates the connection', async () => {
    const app = await createTestApp();
    const { headers } = await signUpUser(app);

    const anon = await app.inject({ method: 'POST', url: '/api/v1/migrate/nocodb/bases', payload: { url: mock.url, token: MOCK_TOKEN } });
    expect(anon.statusCode).toBe(401);

    const ok = await app.inject({ method: 'POST', url: '/api/v1/migrate/nocodb/bases', headers, payload: { url: `${mock.url}/`, token: MOCK_TOKEN } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual([
      { id: 'pinv0001', title: 'Inventory' },
      { id: 'pcrm0002', title: 'CRM' },
    ]);

    const bad = await app.inject({ method: 'POST', url: '/api/v1/migrate/nocodb/bases', headers, payload: { url: mock.url, token: 'nope' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'NOCODB_ERROR', message: 'Invalid NocoDB API token' });

    const invalid = await app.inject({ method: 'POST', url: '/api/v1/migrate/nocodb/bases', headers, payload: { url: mock.url } });
    expect(invalid.statusCode).toBe(400);
  });

  it('starts a background migration job without storing the token', async () => {
    const app = await createTestApp();
    const { headers } = await signUpUser(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/migrate/nocodb',
      headers,
      payload: { url: mock.url, token: MOCK_TOKEN, nocoBaseId: 'pinv0001', targetTitle: 'From NocoDB' },
    });
    expect(res.statusCode).toBe(200);
    const job = res.json() as Job;
    expect(job.kind).toBe('nocodb-migration');

    // Wait for the background run to finish (it fails here unless the real data engine is present).
    for (let i = 0; i < 200 && !['done', 'failed'].includes(jobs.get(job.id)!.status); i++) await new Promise((r) => setTimeout(r, 10));
    const final = jobs.get(job.id)!;
    expect(['done', 'failed']).toContain(final.status);
    expect(JSON.stringify(final)).not.toContain(MOCK_TOKEN);

    const badUrl = await app.inject({ method: 'POST', url: '/api/v1/migrate/nocodb', headers, payload: { url: 'ftp://x', token: 't', nocoBaseId: 'b' } });
    expect(badUrl.statusCode).toBe(400);
  });
});
