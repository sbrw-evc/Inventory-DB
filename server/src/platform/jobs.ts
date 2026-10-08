import type { FastifyInstance } from 'fastify';
import type { Job, JobStatus } from '../../../shared/src/index.js';
import { requireUser } from '../auth/plugin.js';
import { getDb, json, newId, now } from '../db/index.js';
import { notFound } from '../errors.js';
import { doc } from './docs.js';

interface JobRow {
  id: string;
  user_id: string | null;
  kind: Job['kind'];
  status: JobStatus;
  progress: number;
  message: string;
  log: string;
  result: string | null;
  created_at: string;
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  progress: r.progress,
  message: r.message,
  log: json<string[]>(r.log, []),
  result: r.result == null ? undefined : json<unknown>(r.result, undefined),
  createdAt: r.created_at,
});

function getRow(id: string): JobRow {
  const row = getDb().prepare('SELECT * FROM nc_jobs WHERE id = ?').get(id) as JobRow | undefined;
  if (!row) throw notFound('Job');
  return row;
}

/** Creates a queued background job owned by `userId`. */
export function createJob(userId: string | null, kind: Job['kind']): Job {
  const row: JobRow = {
    id: newId('job'),
    user_id: userId,
    kind,
    status: 'queued',
    progress: 0,
    message: '',
    log: '[]',
    result: null,
    created_at: now(),
  };
  getDb()
    .prepare(
      `INSERT INTO nc_jobs (id, user_id, kind, status, progress, message, log, result, created_at)
       VALUES (@id, @user_id, @kind, @status, @progress, @message, @log, @result, @created_at)`,
    )
    .run(row);
  return toJob(row);
}

export interface JobUpdate {
  status?: JobStatus;
  /** 0..1 (clamped) */
  progress?: number;
  message?: string;
  /** Appended as one line to the job log. */
  appendLog?: string;
  result?: unknown;
}

export function updateJob(id: string, patch: JobUpdate): Job {
  const db = getDb();
  return db.transaction(() => {
    const row = getRow(id);
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.progress !== undefined) row.progress = Math.max(0, Math.min(1, patch.progress));
    if (patch.message !== undefined) row.message = patch.message;
    if (patch.appendLog !== undefined) {
      const log = json<string[]>(row.log, []);
      log.push(patch.appendLog);
      row.log = JSON.stringify(log);
    }
    if (patch.result !== undefined) row.result = JSON.stringify(patch.result);
    db.prepare(
      'UPDATE nc_jobs SET status = @status, progress = @progress, message = @message, log = @log, result = @result WHERE id = @id',
    ).run(row);
    return toJob(row);
  })();
}

export function getJob(id: string): Job {
  return toJob(getRow(id));
}

/** Owner of a job (null for system jobs). */
export function getJobUserId(id: string): string | null {
  return getRow(id).user_id;
}

export async function jobRoutes(app: FastifyInstance) {
  app.get<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId',
    { schema: doc('Jobs', 'Get a background job (progress, log, result)') },
    async (req) => {
      const user = requireUser(req);
      const row = getRow(req.params.jobId);
      // Hide other users' jobs entirely.
      if (row.user_id !== user.id) throw notFound('Job');
      return toJob(row);
    },
  );
}
