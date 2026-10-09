/** Entra ID sign-in (OIDC code flow with PKCE) against a stand-in identity provider. */
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearEntraCaches } from '../src/auth/entra.js';
import { getSecret } from '../src/system/secrets.js';
import { createTestApp, signUpUser } from './helpers.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ADMINS = '99999999-0000-0000-0000-000000000001';
const USERS = '99999999-0000-0000-0000-000000000002';

let idp: FastifyInstance;
let idpUrl: string;
let app: FastifyInstance;
let admin: Record<string, string>;
const codes = new Map<string, { nonce: string; challenge: string; user: Record<string, unknown> }>();

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = Fastify();
  idp.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
  idp.get(`/${TENANT}/v2.0/.well-known/openid-configuration`, async () => ({
    issuer: `${idpUrl}/${TENANT}/v2.0`,
    authorization_endpoint: `${idpUrl}/${TENANT}/oauth2/v2.0/authorize`,
    token_endpoint: `${idpUrl}/${TENANT}/oauth2/v2.0/token`,
    jwks_uri: `${idpUrl}/${TENANT}/discovery/v2.0/keys`,
  }));
  idp.get(`/${TENANT}/discovery/v2.0/keys`, async () => ({ keys: [jwk] }));
  idp.post(`/${TENANT}/oauth2/v2.0/token`, async (req, reply) => {
    const b = req.body as Record<string, string>;
    if (b.client_id !== CLIENT || b.client_secret !== 'right-secret')
      return reply.status(401).send({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
    if (b.grant_type === 'client_credentials') return { access_token: 'app', token_type: 'Bearer' };
    const grant = codes.get(b.code);
    if (!grant || createHash('sha256').update(b.code_verifier).digest('base64url') !== grant.challenge) return reply.status(400).send({ error: 'invalid_grant' });
    const idToken = await new SignJWT({ nonce: grant.nonce, ...grant.user })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(`${idpUrl}/${TENANT}/v2.0`)
      .setAudience(CLIENT)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return { id_token: idToken, access_token: 'user-at', token_type: 'Bearer' };
  });
  idpUrl = await idp.listen({ port: 0, host: '127.0.0.1' });
  process.env.ENTRA_AUTHORITY_URL = idpUrl;
  process.env.ENTRA_GRAPH_URL = idpUrl;
  clearEntraCaches();

  app = await createTestApp();
  admin = (await signUpUser(app, 'boss@example.com')).headers;
  await app.inject({ method: 'GET', url: '/api/v1/settings/entra', headers: admin });
});

afterAll(async () => {
  delete process.env.ENTRA_AUTHORITY_URL;
  delete process.env.ENTRA_GRAPH_URL;
  await idp.close();
});

const config = () => ({
  enabled: true,
  cloud: 'global',
  tenant_id: TENANT,
  client_id: CLIENT,
  redirect_url: 'https://inventory.example.com/api/v1/auth/entra/callback',
  admin_group_id: ADMINS,
  user_group_id: USERS,
});
const inject = (method: string, url: string, payload?: unknown, headers: Record<string, string> = admin) =>
  app.inject({ method: method as 'GET', url: `/api/v1${url}`, payload: payload as object, headers });

/** Runs the browser part of the flow: start, "sign in" at the IdP as `user`, come back to the callback. */
async function signInAs(user: Record<string, unknown>) {
  const start = await app.inject({ method: 'GET', url: '/api/v1/auth/entra/start?return=/dcim/devices' });
  expect(start.statusCode).toBe(302);
  const authorize = new URL(start.headers.location as string);
  const cookie = String(start.headers['set-cookie']).split(';')[0];
  const code = `code-${codes.size}`;
  codes.set(code, { nonce: authorize.searchParams.get('nonce')!, challenge: authorize.searchParams.get('code_challenge')!, user });
  const state = authorize.searchParams.get('state')!;
  return app.inject({ method: 'GET', url: `/api/v1/auth/entra/callback?code=${code}&state=${encodeURIComponent(state)}`, headers: { cookie } });
}

describe('Entra ID', () => {
  it('validates the settings and checks the client secret', async () => {
    expect((await inject('POST', '/settings/entra/test', { config: { ...config(), client_id: 'nope' }, client_secret: 'x' })).statusCode).toBe(400);
    expect((await inject('POST', '/settings/entra/test', { config: { ...config(), redirect_url: 'https://x/cb' }, client_secret: 'x' })).statusCode).toBe(400);
    const bad = (await inject('POST', '/settings/entra/test', { config: config(), client_secret: 'wrong' })).json();
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('AADSTS7000215') });
    const ok = (await inject('POST', '/settings/entra/test', { config: config(), client_secret: 'right-secret' })).json();
    expect(ok).toMatchObject({ ok: true, probe: { credentials: true, tenant_id: TENANT, issuer: `${idpUrl}/${TENANT}/v2.0` } });
  });

  it('saves the settings with the client secret in the secret store', async () => {
    const res = (await inject('PUT', '/settings/entra', { config: config(), client_secret: 'right-secret' })).json();
    expect(res).toMatchObject({ client_secret_set: true, config: { enabled: true, tenant_id: TENANT } });
    expect(await getSecret('directory/entra', 'client_secret')).toBe('right-secret');
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/providers' })).json()).toEqual({ ldap: false, entra: true });
  });

  it('signs in a member of the users group and makes admin group members admins', async () => {
    const res = await signInAs({ oid: 'oid-1', name: 'Olga Ivanova', preferred_username: 'Olga@Contoso.com', groups: [USERS, ADMINS] });
    expect(res.statusCode).toBe(302);
    const location = String(res.headers.location);
    expect(location).toMatch(/^\/signin#sso_token=/);
    const fragment = new URLSearchParams(location.split('#')[1]);
    expect(fragment.get('return')).toBe('/dcim/devices');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${fragment.get('sso_token')}` } })).json();
    expect(me).toMatchObject({ user: { email: 'olga@contoso.com', name: 'Olga Ivanova' }, account: { source: 'entra', admin: true } });
  });

  it('refuses users outside the users group and callbacks that do not match the browser session', async () => {
    const outside = await signInAs({ oid: 'oid-2', name: 'Stranger', preferred_username: 'stranger@contoso.com', groups: [] });
    expect(String(outside.headers.location)).toMatch(/^\/signin\?sso_error=.*group/);
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/entra/start' });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const noCookie = await app.inject({ method: 'GET', url: `/api/v1/auth/entra/callback?code=x&state=${encodeURIComponent(state)}` });
    expect(String(noCookie.headers.location)).toMatch(/sso_error=/);
    const denied = await app.inject({ method: 'GET', url: '/api/v1/auth/entra/callback?error=access_denied&error_description=User+cancelled' });
    expect(decodeURIComponent(String(denied.headers.location))).toContain('User cancelled');
  });
});
