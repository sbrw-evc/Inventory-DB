/**
 * Umbrella Identity (docs/identity-federation.md): passkeys, Google / Apple / OpenID Connect sign-in and Umbrella
 * single sign-in with user, role, password policy and passkey synchronization.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { touchSignIn } from '../auth/identity/accounts.js';
import { newRequest } from '../auth/identity/oidc.js';
import {
  PASSKEYS_KEY,
  beginRegistration,
  beginSignIn,
  finishRegistration,
  finishSignIn,
  listPasskeys,
  passkeyConfig,
  passkeyView,
  removePasskey,
  renamePasskey,
} from '../auth/identity/passkeys.js';
import { PROVIDER_KINDS, completeProvider, providerClient, providerTitle, providers, providersView, saveProvider, type ProviderKind } from '../auth/identity/providers.js';
import { UMBRELLA_CALLBACK, completeUmbrella, connect, disconnect, parseKey, checkKey, scheduleUmbrellaSync, syncUmbrella, umbrellaSettings, umbrellaStartUrl } from '../auth/identity/umbrella.js';
import { authUrl } from '../auth/identity/oidc.js';
import { requireUser } from '../auth/plugin.js';
import { getUser, isDisabled, issueJwt, signValue, verifyValue } from '../auth/service.js';
import { HttpError, notFound } from '../errors.js';
import { requireNetboxRole } from '../netbox/access.js';
import { logEvent } from '../system/logbuf.js';
import { readSetting, writeSetting } from '../system/settings.js';

const COOKIE = 'idb_sso';
const PUBLIC_URL_KEY = 'identity.public_url';

const requireAdmin = (req: FastifyRequest) => requireNetboxRole(req, 'admin').user;
const sha = (v: string) => createHash('sha256').update(v).digest('base64url');
const safeReturn = (r: unknown) => (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/\\') ? r : '/');

/** The address people open Inventory DB at: the setting, else the address of the request. */
export function baseUrl(req: FastifyRequest): string {
  const set = readSetting<string>(PUBLIC_URL_KEY, '');
  if (set) return set;
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function cookie(req: FastifyRequest): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

// Apple answers with a cross-site POST, which carries only SameSite=None cookies.
function setCookie(req: FastifyRequest, reply: FastifyReply, value: string, maxAge: number, crossSite = false) {
  const secure = crossSite || req.protocol === 'https' ? '; Secure' : '';
  reply.header('set-cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/api/; HttpOnly; SameSite=${crossSite ? 'None' : 'Lax'}; Max-Age=${maxAge}${secure}`);
}

interface State {
  n: string;
  h: string;
  r: string;
  k: string;
}

async function startState(req: FastifyRequest, reply: FastifyReply, kind: string, crossSite = false) {
  const r = newRequest();
  const state = await signValue({ n: r.nonce, h: sha(r.verifier), r: safeReturn((req.query as { return?: string }).return), k: kind }, '10m');
  setCookie(req, reply, r.verifier, 600, crossSite);
  return { ...r, state };
}

async function finishState(req: FastifyRequest, reply: FastifyReply, kind: string, stateParam?: string) {
  const verifier = cookie(req);
  setCookie(req, reply, '', 0, kind === 'apple');
  const state = stateParam ? await verifyValue<State>(stateParam) : null;
  if (!state || !verifier || state.k !== kind || sha(verifier) !== state.h) return null;
  return { request: { state: stateParam!, nonce: state.n, verifier }, ret: state.r };
}

const fail = (reply: FastifyReply, message: string) => reply.redirect(`/signin?sso_error=${encodeURIComponent(message)}`);

const passkeyAnswer = z.object({ ceremony: z.string().min(1).max(200), credential: z.record(z.unknown()), name: z.string().max(64).optional() });
const providerBody = z.object({
  config: z.object({
    enabled: z.boolean(),
    title: z.string().max(80).default(''),
    issuer: z.string().max(500).default(''),
    client_id: z.string().max(200).default(''),
    team_id: z.string().max(40).default(''),
    key_id: z.string().max(40).default(''),
    allowed_domains: z.array(z.string().max(200)).max(50).default([]),
    existing_only: z.boolean().default(false),
    scopes: z.string().max(200).default(''),
    groups_claim: z.string().max(80).default(''),
    admin_group: z.string().max(200).default(''),
    role: z.enum(['admin', 'editor', 'viewer']).default('viewer'),
  }),
  client_secret: z.string().max(2000).default(''),
  private_key: z.string().max(8000).default(''),
});
const role = z.enum(['admin', 'editor', 'viewer']);
const mappedRole = z.enum(['admin', 'editor', 'viewer', 'none']);
const identityBody = z.object({
  key: z.string().max(4000).default(''),
  enabled: z.boolean().default(true),
  role_map: z.array(z.object({ match: z.string().max(500), role })).max(200).default([]),
  admin_role: mappedRole.default('admin'),
  default_role: mappedRole.default('viewer'),
  link_local: z.boolean().default(true),
  sso: z.boolean().default(true),
  sync_users: z.boolean().default(true),
  sync_policy: z.boolean().default(true),
  sync_passkeys: z.boolean().default(true),
});

export async function identityRoutes(app: FastifyInstance) {
  // Apple posts the callback as a form.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  scheduleUmbrellaSync();

  // ---- what the sign-in page offers
  app.get('/api/v1/auth/methods', async () => {
    const all = providers();
    const u = umbrellaSettings();
    return {
      passkeys: passkeyConfig().enabled,
      providers: PROVIDER_KINDS.filter((k) => all[k].enabled).map((k) => ({ id: k, title: providerTitle(k, all[k]) })),
      umbrella: u.enabled && u.sso ? { hub: u.hub, methods: u.methods } : null,
    };
  });

  // ---- passkeys
  app.post('/api/v1/auth/passkey/begin', async (req) => beginSignIn(req.headers.origin));
  app.post('/api/v1/auth/passkey/finish', async (req) => {
    const body = passkeyAnswer.parse(req.body);
    const { userId, name } = await finishSignIn(body.ceremony, body.credential as never);
    const row = getUser(userId);
    if (isDisabled(userId)) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
    touchSignIn(userId);
    logEvent('warn', 'Signed in with a passkey', { user: row.email, passkey: name });
    return { user: row, token: await issueJwt(row) };
  });
  app.get('/api/v1/auth/me/passkeys', async (req) => listPasskeys(requireUser(req).id).map(passkeyView));
  app.post('/api/v1/auth/me/passkeys/begin', async (req) => beginRegistration(requireUser(req), req.headers.origin));
  app.post('/api/v1/auth/me/passkeys/finish', async (req, reply) => {
    const body = passkeyAnswer.parse(req.body);
    const user = requireUser(req);
    const pk = await finishRegistration(user, body.ceremony, body.credential, body.name);
    logEvent('warn', 'Passkey added', { user: user.email, passkey: pk.name });
    return reply.status(201).send(pk);
  });
  app.patch('/api/v1/auth/me/passkeys/:id', async (req) => {
    renamePasskey(requireUser(req).id, (req.params as { id: string }).id, z.object({ name: z.string().max(64) }).parse(req.body).name);
    return { ok: true };
  });
  app.delete('/api/v1/auth/me/passkeys/:id', async (req, reply) => {
    const user = requireUser(req);
    if (!removePasskey(user.id, (req.params as { id: string }).id)) throw notFound('Passkey');
    logEvent('warn', 'Passkey removed', { user: user.email });
    return reply.status(204).send();
  });
  app.get('/api/v1/settings/users/:id/passkeys', async (req) => {
    requireAdmin(req);
    return listPasskeys((req.params as { id: string }).id).map(passkeyView);
  });
  app.delete('/api/v1/settings/users/:id/passkeys', async (req, reply) => {
    const admin = requireAdmin(req);
    const n = removePasskey((req.params as { id: string }).id);
    logEvent('warn', 'Passkeys of a user removed', { by: admin.email, removed: n });
    return reply.status(204).send();
  });
  app.get('/api/v1/settings/passkeys', async (req) => {
    requireAdmin(req);
    const local = readSetting<{ enabled?: boolean; rp_id?: string }>(PASSKEYS_KEY, {});
    const eff = passkeyConfig(new URL(baseUrl(req) || 'http://localhost').hostname);
    return { enabled: eff.from_hub ? true : !!local.enabled, rp_id: local.rp_id ?? '', from_hub: eff.from_hub, effective_rp_id: eff.rp_id || new URL(baseUrl(req) || 'http://localhost').hostname };
  });
  app.put('/api/v1/settings/passkeys', async (req) => {
    const user = requireAdmin(req);
    const body = z.object({ enabled: z.boolean(), rp_id: z.string().max(253).default('') }).parse(req.body);
    const rp = body.rp_id.trim().toLowerCase().replace(/\.$/, '');
    if (rp && (/[\s/:@]/.test(rp) || (!rp.includes('.') && rp !== 'localhost'))) throw new HttpError(400, 'PASSKEY_DOMAIN', 'Enter a domain name such as example.com');
    writeSetting(PASSKEYS_KEY, { enabled: body.enabled, rp_id: rp }, user.id);
    logEvent('warn', 'Passkey settings changed', { by: user.email, enabled: body.enabled, rp_id: rp });
    return { enabled: body.enabled, rp_id: rp, from_hub: false, effective_rp_id: rp || new URL(baseUrl(req) || 'http://localhost').hostname };
  });

  // ---- the address of Inventory DB (redirect addresses of providers and of Umbrella)
  app.put('/api/v1/settings/public-url', async (req) => {
    const user = requireAdmin(req);
    const raw = z.object({ public_url: z.string().max(500) }).parse(req.body).public_url.trim().replace(/\/+$/, '');
    if (raw) {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        throw new HttpError(400, 'PUBLIC_URL', 'Enter an address such as https://inventory.example.com');
      }
      if (!['http:', 'https:'].includes(u.protocol) || u.search || u.hash) throw new HttpError(400, 'PUBLIC_URL', 'Enter an address such as https://inventory.example.com');
    }
    writeSetting(PUBLIC_URL_KEY, raw, user.id);
    return { public_url: raw };
  });

  // ---- Google / Apple / OpenID Connect
  app.get('/api/v1/settings/providers', async (req) => {
    requireAdmin(req);
    return providersView(baseUrl(req));
  });
  app.put('/api/v1/settings/providers/:kind', async (req) => {
    const user = requireAdmin(req);
    const kind = (req.params as { kind: string }).kind as ProviderKind;
    if (!PROVIDER_KINDS.includes(kind)) throw notFound('Provider');
    const body = providerBody.parse(req.body);
    await saveProvider(kind, body.config, body.client_secret, body.private_key, user.id);
    return providersView(baseUrl(req));
  });
  app.get('/api/v1/auth/sso/:kind/start', async (req, reply) => {
    const kind = (req.params as { kind: string }).kind as ProviderKind;
    if (!PROVIDER_KINDS.includes(kind) || !providers()[kind].enabled) return fail(reply, 'This sign-in method is turned off');
    try {
      const { client } = await providerClient(kind, baseUrl(req));
      const r = await startState(req, reply, kind, kind === 'apple');
      return reply.redirect(await authUrl(client, r));
    } catch (e) {
      logEvent('error', 'Provider sign-in could not start', { provider: kind, error: (e as Error).message });
      return fail(reply, 'The sign-in provider did not answer. Try again later.');
    }
  });
  const providerCallback = async (req: FastifyRequest, reply: FastifyReply) => {
    const kind = (req.params as { kind: string }).kind as ProviderKind;
    const q = { ...(req.query as Record<string, string>), ...((req.body as Record<string, string>) ?? {}) };
    if (q.error) return fail(reply, 'The provider refused the sign-in or it was cancelled.');
    const st = await finishState(req, reply, kind, q.state);
    if (!st || !q.code) return fail(reply, 'The sign-in took too long or was started in another browser. Try again.');
    try {
      const user = await completeProvider(kind, baseUrl(req), q.code, st.request, q.user);
      touchSignIn(user.id);
      logEvent('warn', 'Signed in with a provider', { provider: kind, user: user.email });
      return reply.redirect(`/signin#sso_token=${encodeURIComponent(await issueJwt(user))}&return=${encodeURIComponent(st.ret)}`);
    } catch (e) {
      logEvent('warn', 'Provider sign-in rejected', { provider: kind, error: (e as Error).message });
      return fail(reply, (e as Error).message);
    }
  };
  app.get('/api/v1/auth/sso/:kind/callback', providerCallback);
  app.post('/api/v1/auth/sso/:kind/callback', providerCallback);

  // ---- Umbrella single sign-in
  app.get('/api/v1/settings/identity', async (req) => {
    requireAdmin(req);
    const s = umbrellaSettings();
    const base = baseUrl(req);
    return { ...s, connected: !!s.hub && !!s.client_id, public_url: base, redirect_uri: base ? `${base}${UMBRELLA_CALLBACK}` : '' };
  });
  app.post('/api/v1/settings/identity/check', async (req) => {
    requireAdmin(req);
    const { key } = z.object({ key: z.string().max(4000) }).parse(req.body);
    return checkKey(parseKey(key), baseUrl(req));
  });
  app.put('/api/v1/settings/identity', async (req) => {
    const user = requireAdmin(req);
    await connect(identityBody.parse(req.body), baseUrl(req), user.id);
    const s = umbrellaSettings();
    return { ...s, connected: true, public_url: baseUrl(req), redirect_uri: `${baseUrl(req)}${UMBRELLA_CALLBACK}` };
  });
  app.post('/api/v1/settings/identity/sync', async (req) => {
    const user = requireAdmin(req);
    await syncUmbrella(user.email);
    return { ...umbrellaSettings(), connected: true, public_url: baseUrl(req), redirect_uri: `${baseUrl(req)}${UMBRELLA_CALLBACK}` };
  });
  app.delete('/api/v1/settings/identity', async (req) => {
    const user = requireAdmin(req);
    return { ...(await disconnect(user.id)), connected: false };
  });
  app.get('/api/v1/auth/umbrella/start', async (req, reply) => {
    const hint = String((req.query as { method?: string }).method ?? '');
    try {
      const r = await startState(req, reply, 'umbrella');
      return reply.redirect(await umbrellaStartUrl(baseUrl(req), hint, r));
    } catch (e) {
      logEvent('error', 'Umbrella sign-in could not start', { error: (e as Error).message });
      return fail(reply, 'Umbrella Monitoring did not answer. Try again later or sign in with an Inventory DB account.');
    }
  });
  app.get(UMBRELLA_CALLBACK, async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.error) return fail(reply, q.error === 'access_denied' ? 'Your Umbrella account has no access to Inventory DB.' : 'Umbrella refused the sign-in or it was cancelled.');
    const st = await finishState(req, reply, 'umbrella', q.state);
    if (!st || !q.code) return fail(reply, 'The sign-in took too long or was started in another browser. Try again.');
    try {
      const user = await completeUmbrella(baseUrl(req), q.code, st.request);
      touchSignIn(user.id);
      logEvent('warn', 'Signed in with Umbrella', { user: user.email });
      return reply.redirect(`/signin#sso_token=${encodeURIComponent(await issueJwt(user))}&return=${encodeURIComponent(st.ret)}`);
    } catch (e) {
      logEvent('warn', 'Umbrella sign-in rejected', { error: (e as Error).message });
      return fail(reply, (e as Error).message);
    }
  });
}
