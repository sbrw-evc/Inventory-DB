import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.js';
import { dataRoutes } from './data.js';
import { integrationRoutes } from './integrations.js';
import { metaRoutes } from './meta.js';
import { migrateRoutes } from './migrate.js';
import { netboxRoutes } from './netbox.js';
import { platformRoutes } from './platform.js';
import { settingsRoutes } from './settings.js';

/** Each feature area owns one route module. */
export async function registerRoutes(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(metaRoutes);
  await app.register(dataRoutes);
  await app.register(platformRoutes);
  await app.register(migrateRoutes);
  await app.register(netboxRoutes);
  await app.register(integrationRoutes);
  await app.register(settingsRoutes);
}
