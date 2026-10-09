import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiToken } from '../../../shared/src/index.js';
import { requireUser } from '../auth/plugin.js';
import { createApiToken } from '../auth/service.js';
import { getDb } from '../db/index.js';
import { notFound } from '../errors.js';
import { doc } from './docs.js';

export async function tokenRoutes(app: FastifyInstance) {
  app.get('/api/v1/tokens', { schema: doc('API tokens', 'List your API tokens') }, async (req) => {
    const user = requireUser(req);
    return getDb()
      .prepare('SELECT id, description, created_at AS "createdAt" FROM nc_api_tokens WHERE user_id = ? ORDER BY created_at DESC')
      .all(user.id) as ApiToken[];
  });

  app.post('/api/v1/tokens', { schema: doc('API tokens', 'Create an API token (the token is returned only once)') }, async (req) => {
    const user = requireUser(req);
    const body = z.object({ description: z.string().trim().max(255).optional() }).parse(req.body ?? {});
    const token: ApiToken = createApiToken(user.id, body.description || 'API token');
    return token;
  });

  app.delete<{ Params: { tokenId: string } }>(
    '/api/v1/tokens/:tokenId',
    { schema: doc('API tokens', 'Revoke an API token') },
    async (req) => {
      const user = requireUser(req);
      const res = getDb().prepare('DELETE FROM nc_api_tokens WHERE id = ? AND user_id = ?').run(req.params.tokenId, user.id);
      if (res.changes === 0) throw notFound('Token');
      return { ok: true };
    },
  );
}
