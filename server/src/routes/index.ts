import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.js';
import { dataRoutes } from './data.js';
import { metaRoutes } from './meta.js';
import { migrateRoutes } from './migrate.js';
import { platformRoutes } from './platform.js';

/** Each feature area owns one route module. */
export async function registerRoutes(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(metaRoutes);
  await app.register(dataRoutes);
  await app.register(platformRoutes);
  await app.register(migrateRoutes);
}
