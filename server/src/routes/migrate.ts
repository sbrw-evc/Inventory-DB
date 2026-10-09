import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { HttpError, badRequest } from '../errors.js';
import { NocoDBClient, NocoDBError, normalizeBaseUrl } from '../migrate/nocodbClient.js';
import { runMigration } from '../migrate/nocodbMigration.js';
import { createJob } from '../platform/jobs.js';

const connection = z.object({
  url: z.string().trim().min(1).max(2000),
  token: z.string().trim().min(1).max(4000),
});

const migrateBody = connection.extend({
  nocoBaseId: z.string().trim().min(1).max(200),
  targetTitle: z.string().trim().max(255).optional(),
});

/** NocoDB failures are reported as 400s (not 401) so the web app doesn't mistake them for our own auth. */
function nocoError(err: unknown): never {
  if (err instanceof NocoDBError) throw new HttpError(400, 'NOCODB_ERROR', err.message);
  throw err;
}

/**
 * NocoDB migration. The NocoDB token is used for the requests below and handed to the background job in memory
 * only: it is never logged (request bodies aren't logged by Fastify) nor stored in the job, its log or result.
 */
export async function migrateRoutes(app: FastifyInstance) {
  app.post('/api/v1/migrate/nocodb/bases', async (req) => {
    requireUser(req);
    const body = connection.parse(req.body);
    let client: NocoDBClient;
    try {
      client = new NocoDBClient({ url: body.url, token: body.token, maxRetries: 2 });
    } catch (err) {
      return nocoError(err);
    }
    try {
      return await client.listBases();
    } catch (err) {
      return nocoError(err);
    }
  });

  app.post('/api/v1/migrate/nocodb', async (req) => {
    const user = requireUser(req);
    const body = migrateBody.parse(req.body);
    try {
      normalizeBaseUrl(body.url);
    } catch (err) {
      if (err instanceof NocoDBError) throw badRequest(err.message);
      throw err;
    }
    const job = createJob(user.id, 'nocodb-migration');
    // Background: runMigration records success/failure on the job and never rejects.
    void runMigration({
      url: body.url,
      token: body.token,
      nocoBaseId: body.nocoBaseId,
      targetTitle: body.targetTitle || undefined,
      userId: user.id,
      jobId: job.id,
    });
    return job;
  });
}
