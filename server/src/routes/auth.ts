import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { passwordExpiresAt } from '../../../shared/src/passwordPolicy.js';
import { activeEntra, entraClientSecret, getLdapConfig, provisionExternalUser } from '../auth/directory.js';
import { authorizeUrl, completeSignIn, pkce } from '../auth/entra.js';
import { requireUser } from '../auth/plugin.js';
import { getPolicy } from '../auth/policy.js';
import { accountInfo, changePassword, issueJwt, signIn, signUp, signValue, verifyValue } from '../auth/service.js';
import { getNetboxRole } from '../netbox/access.js';
import { logEvent } from '../system/logbuf.js';

const signUpBody = z.object({ email: z.string().email(), password: z.string().min(1), name: z.string().optional() });
// `email` is the login: an email for local accounts, the directory user name for LDAP / AD.
const signInBody = z.object({ email: z.string().trim().min(1).max(256), password: z.string().min(1) });
const passwordBody = z.object({ email: z.string().trim().min(1), password: z.string().min(1), newPassword: z.string().min(1) });

const COOKIE = 'idb_entra';
const COOKIE_PATH = '/api/v1/auth/entra';

function cookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setCookie(req: FastifyRequest, reply: FastifyReply, value: string, maxAge: number) {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  reply.header('set-cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

/** Only same-site paths are followed after sign-in. */
const safeReturn = (r: unknown) => (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/\\') ? r : '/');
const sha = (v: string) => createHash('sha256').update(v).digest('base64url');

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/v1/auth/providers', async () => ({ ldap: getLdapConfig().enabled, entra: !!activeEntra() }));

  app.post('/api/v1/auth/signup', async (req) => {
    const body = signUpBody.parse(req.body);
    const user = await signUp(body.email, body.password, body.name);
    return { user, token: await issueJwt(user) };
  });

  app.post('/api/v1/auth/signin', async (req) => {
    const body = signInBody.parse(req.body);
    const user = await signIn(body.email, body.password);
    return { user, token: await issueJwt(user) };
  });

  /** Change a local account's password; works without a session so an expired password can be replaced. */
  app.post('/api/v1/auth/password', async (req) => {
    const body = passwordBody.parse(req.body);
    const user = await changePassword(body.email, body.password, body.newPassword);
    return { user, token: await issueJwt(user) };
  });

  app.get('/api/v1/auth/me', async (req) => {
    const user = requireUser(req);
    const info = accountInfo(user.id);
    const policy = getPolicy();
    const expires = info.source === 'local' ? passwordExpiresAt(info.passwordChangedAt, policy) : null;
    const warn = !!expires && !!policy.warn_days && Date.parse(expires) - Date.now() <= policy.warn_days * 86_400_000;
    return { user, account: { source: info.source, admin: getNetboxRole(user.id) === 'admin', passwordExpiresAt: expires, passwordExpiresSoon: warn } };
  });

  /** Entra ID sign-in: off to Microsoft with PKCE; the verifier waits in an HttpOnly cookie bound to the state. */
  app.get('/api/v1/auth/entra/start', async (req, reply) => {
    const config = activeEntra();
    if (!config) return reply.redirect(`/signin?sso_error=${encodeURIComponent('Entra ID sign-in is not configured')}`);
    const { verifier, challenge } = pkce();
    const nonce = randomBytes(16).toString('base64url');
    const state = await signValue({ n: nonce, h: sha(verifier), r: safeReturn((req.query as { return?: string }).return) }, '10m');
    try {
      const url = await authorizeUrl(config, { state, nonce, challenge });
      setCookie(req, reply, verifier, 600);
      return reply.redirect(url);
    } catch (e) {
      logEvent('error', 'Entra ID sign-in could not start', { error: (e as Error).message });
      return reply.redirect(`/signin?sso_error=${encodeURIComponent((e as Error).message)}`);
    }
  });

  app.get('/api/v1/auth/entra/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const verifier = cookie(req, COOKIE);
    setCookie(req, reply, '', 0);
    const fail = (message: string) => reply.redirect(`/signin?sso_error=${encodeURIComponent(message)}`);
    if (q.error) return fail((q.error_description || q.error).split(/\r?\n/)[0]);
    const config = activeEntra();
    if (!config) return fail('Entra ID sign-in is not configured');
    const state = q.state ? await verifyValue<{ n: string; h: string; r: string }>(q.state) : null;
    if (!state || !q.code || !verifier || sha(verifier) !== state.h) return fail('The sign-in took too long or was started in another browser. Try again.');
    try {
      const identity = await completeSignIn(config, await entraClientSecret(), q.code, verifier, state.n);
      const user = provisionExternalUser({ source: 'entra', externalId: identity.oid, email: identity.email, name: identity.name, admin: identity.admin });
      const token = await issueJwt(user);
      return reply.redirect(`/signin#sso_token=${encodeURIComponent(token)}&return=${encodeURIComponent(safeReturn(state.r))}`);
    } catch (e) {
      logEvent('warn', 'Entra ID sign-in rejected', { error: (e as Error).message });
      return fail((e as Error).message);
    }
  });
}
