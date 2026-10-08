import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { authPlugin } from './auth/plugin.js';
import { HttpError } from './errors.js';
import { registerRoutes } from './routes/index.js';

export interface AppOptions {
  logger?: boolean;
  /** Directory of the built web app to serve at `/` (production). */
  webDist?: string;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 50 * 1024 * 1024,
    // NetBox-style clients call list endpoints with a trailing slash.
    routerOptions: { ignoreTrailingSlash: true },
  });

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  // Called directly (not registered) so its hook applies to every route, not just an encapsulated scope.
  await authPlugin(app);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: 'Invalid request', details: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.status(status).send({ error: status >= 500 ? 'INTERNAL' : 'BAD_REQUEST', message: (err as Error).message });
  });

  await registerRoutes(app);

  app.get('/api/v1/health', async () => ({ ok: true }));

  const webDist = opts.webDist ?? resolve(process.cwd(), '../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Route not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
