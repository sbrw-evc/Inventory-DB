import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { issueJwt, signIn, signUp } from '../auth/service.js';

const credentials = z.object({ email: z.string().email(), password: z.string().min(1), name: z.string().optional() });

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/v1/auth/signup', async (req) => {
    const body = credentials.parse(req.body);
    const user = await signUp(body.email, body.password, body.name);
    return { user, token: await issueJwt(user) };
  });

  app.post('/api/v1/auth/signin', async (req) => {
    const body = credentials.parse(req.body);
    const user = await signIn(body.email, body.password);
    return { user, token: await issueJwt(user) };
  });

  app.get('/api/v1/auth/me', async (req) => ({ user: requireUser(req) }));
}
