/**
 * Sign-in with SPA (docs/spa.md): OpenID Connect authorization code flow with PKCE S256, nonce and a signed,
 * single-use state; the verifier waits in an HttpOnly cookie bound to the state. After the callback Inventory DB
 * starts its own session (a JWT). Sign-out ends it and goes to SPA's sign-out.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { accountInfo, issueJwt, signValue, verifyValue } from '../auth/service.js';
import { SPA_CALLBACK, loadKey, oidcClient, publicBase } from '../auth/spa/connection.js';
import { authUrl, exchange, newRequest, strings, verify } from '../auth/spa/oidc.js';
import { fetchConfig, spaState } from '../auth/spa/sync.js';
import { roleFrom, touchSignIn, upsertSpaUser } from '../auth/spa/users.js';
import { getNetboxRole } from '../netbox/access.js';
import { logEvent } from '../system/logbuf.js';

const COOKIE = 'idb_spa';
const COOKIE_PATH = '/api/auth/spa/';
const STATE_TTL_S = 600;

const IDP_HINTS = ['password', 'passkey', 'ldap', 'entra', 'google', 'apple', 'oidc'];

/** Only same-site paths are followed after sign-in. */
const safeReturn = (r: unknown) => (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/\\') ? r : '/');
const sha = (v: string) => createHash('sha256').update(v).digest('base64url');

function cookie(req: FastifyRequest): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setCookie(req: FastifyRequest, reply: FastifyReply, value: string, maxAge: number) {
  const https = req.protocol === 'https' || publicBase(req).startsWith('https:');
  reply.header('set-cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? '; Secure' : ''}`);
}

// States already redeemed (single use), until they expire.
const usedStates = new Map<string, number>();
function redeemState(id: string): boolean {
  const t = Date.now();
  for (const [k, until] of usedStates) if (until < t) usedStates.delete(k);
  if (usedStates.has(id)) return false;
  usedStates.set(id, t + STATE_TTL_S * 1000);
  return true;
}

interface State {
  /** random ID of the state */
  s: string;
  n: string;
  h: string;
  r: string;
  k: 'spa';
}

const signInPage = (reply: FastifyReply, message: string) => reply.redirect(`/signin?sso_error=${encodeURIComponent(message)}`);

const NOT_CONNECTED = 'This application is not connected to SPA';

export async function authRoutes(app: FastifyInstance) {
  // ---- what the sign-in page needs (public)
  app.get('/api/v1/auth/spa', async () => {
    const { key } = await loadKey();
    if (!key) return { connected: false };
    const s = spaState(key);
    return { connected: true, issuer: key.issuer, application: s.config?.application?.name ?? null };
  });

  app.get('/api/v1/auth/me', async (req) => {
    const user = requireUser(req);
    const info = accountInfo(user.id);
    const role = getNetboxRole(user.id);
    const { key } = await loadKey();
    const cfg = key ? spaState(key).config : undefined;
    return {
      user,
      account: {
        source: info.source,
        username: info.username,
        admin: role === 'admin',
        role,
        spa: key ? { issuer: key.issuer, account_url: cfg?.account_url || `${key.issuer}/profile` } : null,
      },
    };
  });

  // ---- 1. off to SPA
  app.get('/api/auth/spa/start', async (req, reply) => {
    const q = req.query as { return?: string; login_hint?: string; idp_hint?: string; prompt?: string };
    const { key } = await loadKey();
    const base = publicBase(req);
    if (!key || !base) return signInPage(reply, NOT_CONNECTED);
    const r = newRequest();
    const state = await signValue({ s: r.state, n: r.nonce, h: sha(r.verifier), r: safeReturn(q.return), k: 'spa' } satisfies State, `${STATE_TTL_S}s`);
    const extra: Record<string, string> = {};
    if (q.login_hint && q.login_hint.length <= 256) extra.login_hint = q.login_hint;
    if (q.idp_hint && IDP_HINTS.includes(q.idp_hint)) extra.idp_hint = q.idp_hint;
    if (q.prompt === 'login') extra.prompt = 'login';
    try {
      const url = await authUrl(oidcClient(key, base, extra), { ...r, state });
      setCookie(req, reply, r.verifier, STATE_TTL_S);
      return reply.redirect(url);
    } catch (e) {
      logEvent('error', 'SPA sign-in could not start', { error: (e as Error).message });
      return signInPage(reply, 'SPA did not answer. Try again later.');
    }
  });

  // ---- 3. back from SPA
  app.get(SPA_CALLBACK, async (req, reply) => {
    const q = z.record(z.string()).catch({}).parse(req.query) as Record<string, string | undefined>;
    const verifier = cookie(req);
    setCookie(req, reply, '', 0);
    if (q.error) {
      logEvent('warn', 'SPA refused the sign-in', { error: q.error, description: q.error_description });
      return signInPage(reply, q.error === 'access_denied' ? 'You have no access to Inventory DB. Ask an SPA administrator for a role.' : 'SPA refused the sign-in or it was cancelled.');
    }
    const { key } = await loadKey();
    const base = publicBase(req);
    if (!key || !base) return signInPage(reply, NOT_CONNECTED);
    const state = q.state ? await verifyValue<State>(q.state) : null;
    if (!state || state.k !== 'spa' || !q.code || !verifier || sha(verifier) !== state.h || !redeemState(state.s))
      return signInPage(reply, 'The sign-in took too long or was started in another browser. Try again.');
    try {
      const client = oidcClient(key, base);
      const t = await exchange(client, q.code, { state: q.state!, nonce: state.n, verifier });
      const cl = await verify(client, t.id_token, state.n);
      const role = roleFrom(strings(cl.roles));
      if (!role) {
        logEvent('warn', 'SPA sign-in without a role in Inventory DB', { sub: cl.sub });
        return signInPage(reply, 'You have no access to Inventory DB. Ask an SPA administrator for a role.');
      }
      const { user } = upsertSpaUser({
        sub: String(cl.sub),
        username: String(cl.preferred_username ?? ''),
        email: String(cl.email ?? ''),
        name: String(cl.name ?? ''),
        role,
        disabled: false,
      });
      touchSignIn(user.id);
      logEvent('warn', 'Signed in with SPA', { user: user.email || String(cl.preferred_username ?? ''), role, amr: strings(cl.amr).join(' ') });
      return reply.redirect(`/signin#sso_token=${encodeURIComponent(await issueJwt(user))}&return=${encodeURIComponent(safeReturn(state.r))}`);
    } catch (e) {
      logEvent('warn', 'SPA sign-in rejected', { error: (e as Error).message });
      return signInPage(reply, 'SPA sign-in could not be completed. Try again.');
    }
  });

  // ---- sign-out: the browser drops its session and comes here; SPA ends its own and returns to our address.
  app.get('/api/auth/spa/logout', async (req, reply) => {
    const { key } = await loadKey();
    const base = publicBase(req);
    if (!key || !base) return reply.redirect('/signin?signed_out=1');
    const s = spaState(key);
    let url = s.config?.sign_out_url;
    if (!url) url = (await fetchConfig(key, s).catch(() => undefined))?.sign_out_url;
    url ||= `${key.issuer}/oauth2/logout`;
    const qs = new URLSearchParams({ post_logout_redirect_uri: `${base}/`, client_id: key.client_id });
    return reply.redirect(`${url}${url.includes('?') ? '&' : '?'}${qs}`);
  });
}
