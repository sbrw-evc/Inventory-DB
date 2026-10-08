import type { FastifyInstance } from 'fastify';
import { auditRoutes } from '../platform/audit.js';
import { commentRoutes } from '../platform/comments.js';
import { exportRoutes } from '../platform/export.js';
import { fileRoutes } from '../platform/files.js';
import { importRoutes } from '../platform/import.js';
import { jobRoutes } from '../platform/jobs.js';
import { memberRoutes } from '../platform/members.js';
import { sharingRoutes } from '../platform/sharing.js';
import { templateRoutes } from '../platform/template.js';
import { tokenRoutes } from '../platform/tokens.js';
import { webhookRoutes } from '../platform/webhooks.js';

/**
 * Platform features: members, tokens, files, sharing, comments, audit, webhooks, import/export, templates, jobs.
 * Audit and webhook modules subscribe to the record event bus once per process (idempotent).
 */
export async function platformRoutes(app: FastifyInstance) {
  await app.register(jobRoutes);
  await app.register(memberRoutes);
  await app.register(tokenRoutes);
  await app.register(fileRoutes);
  await app.register(sharingRoutes);
  await app.register(commentRoutes);
  await app.register(auditRoutes);
  await app.register(webhookRoutes);
  await app.register(importRoutes);
  await app.register(exportRoutes);
  await app.register(templateRoutes);
}
