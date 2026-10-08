import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance, FastifySchema } from 'fastify';

/**
 * OpenAPI spec + Swagger UI at /api/v1/docs (spec at /api/v1/docs/json).
 * Must be called before any routes are registered so @fastify/swagger sees them all.
 */
export async function registerDocs(app: FastifyInstance) {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Inventory DB API',
        description: 'NocoDB-style REST API. Authenticate with `Authorization: Bearer <jwt>` or `xc-token: <api token>`.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
          xcToken: { type: 'apiKey', in: 'header', name: 'xc-token' },
        },
      },
      security: [{ bearerAuth: [] }, { xcToken: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/v1/docs' });
}

/** Small helper so route modules can tag themselves for the docs. */
export const doc = (tag: string, summary: string): FastifySchema => ({ tags: [tag], summary });
