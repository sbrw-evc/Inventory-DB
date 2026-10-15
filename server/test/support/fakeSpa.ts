/**
 * A stand-in SPA for the tests: an OpenID Connect issuer (discovery, authorize → code, token with PKCE, RS256 JWKS,
 * user info, sign-out) and the federation API (`/api/spa/v1/{config,users,roles}` with a Bearer token and ETags),
 * as SPA's docs/protocol.md describes them.
 */
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, importJWK, type JWK } from 'jose';

export interface FakeSpaUser {
  id: string;
  username: string;
  email: string;
  name: string;
  disabled: boolean;
  roles: string[];
  groups: string[];
  source?: string;
  updated_at?: string;
}

export interface FakeSpa {
  url: string;
  clientId: string;
  clientSecret: string;
  token: string;
  /** The connection key `spa1.…` SPA shows once. */
  key(): string;
  users: FakeSpaUser[];
  /** The person who signs in at the authorize endpoint. */
  signedIn: string;
  /** Answer the next authorize with `error=access_denied`. */
  deny: boolean;
  /** Spoil the next ID tokens (tests of the relying party's checks). */
  tamper: { iss?: string; aud?: string; nonce?: string; foreignKey?: boolean; expired?: boolean; alg?: 'HS256' };
  /** Role catalogues the application published. */
  published: unknown[];
  /** Authorize requests as received. */
  authorizeQueries: Record<string, string>[];
  /** Federation calls: method, path, If-None-Match and status. */
  calls: { method: string; path: string; etag?: string; status: number }[];
  config: Record<string, unknown>;
  close(): Promise<void>;
}

export async function startFakeSpa(opts: { clientId?: string } = {}): Promise<FakeSpa> {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk: JWK = { ...(await exportJWK(rsa.publicKey)), kid: 'spa-1', alg: 'RS256', use: 'sig' };
  const signer = await importJWK({ ...(rsa.privateKey.export({ format: 'jwk' }) as JWK), alg: 'RS256' }, 'RS256');
  const foreign = await importJWK({ ...(other.privateKey.export({ format: 'jwk' }) as JWK), alg: 'RS256' }, 'RS256');
  const codes = new Map<string, { user: string; nonce: string; challenge: string; redirect: string; at: number }>();

  const app: FastifyInstance = Fastify();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, b, done) => done(null, Object.fromEntries(new URLSearchParams(b as string))));

  const spa: FakeSpa = {
    url: '',
    clientId: opts.clientId ?? 'app_inventory',
    clientSecret: `sec_${randomBytes(8).toString('hex')}`,
    token: `fed_${randomBytes(8).toString('hex')}`,
    key() {
      return `spa1.${Buffer.from(JSON.stringify({ issuer: spa.url, client_id: spa.clientId, client_secret: spa.clientSecret, token: spa.token })).toString('base64url')}`;
    },
    users: [],
    signedIn: '',
    deny: false,
    tamper: {},
    published: [],
    authorizeQueries: [],
    calls: [],
    config: {},
    close: () => app.close(),
  };

  app.get('/.well-known/openid-configuration', async () => ({
    issuer: spa.url,
    authorization_endpoint: `${spa.url}/oauth2/authorize`,
    token_endpoint: `${spa.url}/oauth2/token`,
    jwks_uri: `${spa.url}/oauth2/jwks`,
    userinfo_endpoint: `${spa.url}/oauth2/userinfo`,
    end_session_endpoint: `${spa.url}/oauth2/logout`,
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
  }));
  app.get('/oauth2/jwks', async () => ({ keys: [jwk] }));

  app.get('/oauth2/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    spa.authorizeQueries.push(q);
    if (q.client_id !== spa.clientId) return reply.status(400).send({ error: 'invalid_client' });
    if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge || !q.nonce || !q.state || !q.scope?.split(' ').includes('openid'))
      return reply.status(400).send({ error: 'invalid_request' });
    const back = new URL(q.redirect_uri);
    back.searchParams.set('state', q.state);
    const u = spa.users.find((x) => x.id === spa.signedIn);
    if (spa.deny || !u || u.disabled || !u.roles.length) {
      spa.deny = false;
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('error_description', 'No role in this application');
      return reply.redirect(back.toString());
    }
    const code = randomBytes(12).toString('base64url');
    codes.set(code, { user: u.id, nonce: q.nonce, challenge: q.code_challenge, redirect: q.redirect_uri, at: Date.now() });
    back.searchParams.set('code', code);
    return reply.redirect(back.toString());
  });

  app.post('/oauth2/token', async (req, reply) => {
    const b = req.body as Record<string, string>;
    if (b.client_id !== spa.clientId || b.client_secret !== spa.clientSecret) return reply.status(401).send({ error: 'invalid_client' });
    const c = codes.get(b.code);
    codes.delete(b.code);
    if (!c || Date.now() - c.at > 60_000 || c.redirect !== b.redirect_uri || !b.code_verifier || createHash('sha256').update(b.code_verifier).digest('base64url') !== c.challenge)
      return reply.status(400).send({ error: 'invalid_grant' });
    const u = spa.users.find((x) => x.id === c.user)!;
    const t = spa.tamper;
    const jwt = new SignJWT({
      nonce: t.nonce ?? c.nonce,
      preferred_username: u.username,
      name: u.name,
      email: u.email,
      email_verified: true,
      roles: u.roles,
      groups: u.groups,
      amr: ['hwk', 'user'],
      auth_time: Math.floor(Date.now() / 1000),
      sid: 'sid-1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'spa-1' })
      .setIssuer(t.iss ?? spa.url)
      .setAudience(t.aud ?? spa.clientId)
      .setSubject(u.id)
      .setIssuedAt();
    if (t.expired) jwt.setIssuedAt(Math.floor(Date.now() / 1000) - 3600).setExpirationTime(Math.floor(Date.now() / 1000) - 600);
    else jwt.setExpirationTime('5m');
    let idToken: string;
    if (t.alg === 'HS256') idToken = await jwt.setProtectedHeader({ alg: 'HS256', kid: 'spa-1' }).sign(new TextEncoder().encode(spa.clientSecret.padEnd(32, 'x')));
    else idToken = await jwt.sign(t.foreignKey ? foreign : signer);
    return { id_token: idToken, access_token: `at_${u.id}`, token_type: 'Bearer', expires_in: 600 };
  });

  app.get('/oauth2/logout', async () => ({ ok: true }));

  const federation = (body: () => unknown) => async (req: { method: string; url: string; headers: Record<string, unknown> }, reply: { status: (n: number) => { send: (v?: unknown) => unknown }; header: (k: string, v: string) => void }) => {
    const call = { method: req.method, path: req.url, etag: req.headers['if-none-match'] as string | undefined, status: 200 };
    spa.calls.push(call);
    if (req.headers.authorization !== `Bearer ${spa.token}`) {
      call.status = 401;
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const data = body();
    const tag = `"${createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)}"`;
    reply.header('etag', tag);
    if (req.headers['if-none-match'] === tag) {
      call.status = 304;
      return reply.status(304).send();
    }
    return data;
  };
  app.get(
    '/api/spa/v1/config',
    federation(() => ({
      application: { id: spa.clientId, name: 'Inventory DB', type: 'inventory-db' },
      roles: [
        { id: 'admin', name: 'Administrator' },
        { id: 'editor', name: 'Editor' },
        { id: 'viewer', name: 'Viewer' },
      ],
      methods: [
        { id: 'passkey', title: 'Passkey' },
        { id: 'ldap', title: 'Active Directory' },
      ],
      sign_out_url: `${spa.url}/oauth2/logout`,
      account_url: `${spa.url}/profile`,
      ...spa.config,
    })) as never,
  );
  app.get('/api/spa/v1/users', federation(() => ({ users: spa.users })) as never);
  app.put('/api/spa/v1/roles', async (req, reply) => {
    spa.calls.push({ method: 'PUT', path: '/api/spa/v1/roles', status: 200 });
    if (req.headers.authorization !== `Bearer ${spa.token}`) return reply.status(401).send({ error: 'unauthorized' });
    spa.published.push(req.body);
    return { ok: true };
  });

  spa.url = await app.listen({ port: 0, host: '127.0.0.1' });
  return spa;
}
