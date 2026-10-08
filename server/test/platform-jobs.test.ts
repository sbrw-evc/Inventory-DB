import { describe, expect, it } from 'vitest';
import { createJob, getJob, updateJob } from '../src/platform/jobs.js';
import { createTestApp, signUpUser } from './helpers.js';

describe('jobs', () => {
  it('creates, updates and serves a job only to its owner', async () => {
    const app = await createTestApp();
    const a = await signUpUser(app);
    const b = await signUpUser(app);
    const job = createJob(a.userId, 'nocodb-migration');
    expect(job.status).toBe('queued');
    updateJob(job.id, { status: 'running', progress: 0.5, message: 'Copying', appendLog: 'step 1' });
    updateJob(job.id, { appendLog: 'step 2', progress: 7 });
    const done = updateJob(job.id, { status: 'done', result: { baseId: 'b1', skipped: [] } });
    expect(done.log).toEqual(['step 1', 'step 2']);
    expect(done.progress).toBe(1);
    expect(getJob(job.id).result).toEqual({ baseId: 'b1', skipped: [] });

    const res = await app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}`, headers: a.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe('Copying');
    const other = await app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}`, headers: b.headers });
    expect(other.statusCode).toBe(404);
    const anon = await app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    expect(anon.statusCode).toBe(401);
  });
});
