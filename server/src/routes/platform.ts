import type { FastifyInstance } from 'fastify';
import { jobRoutes } from '../platform/jobs.js';

/** Platform features: members, tokens, files, sharing, comments, audit, webhooks, import/export, templates, jobs. */
export async function platformRoutes(app: FastifyInstance) {
  await app.register(jobRoutes);
}
