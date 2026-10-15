/** Umbrella Identity: a stand-in hub (OIDC + federation API), single sign-in, synchronization, passkeys, policy. */
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { SignJWT, exportJWK, importJWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearOidcCaches } from '../src/auth/identity/oidc.js';
import { createTestApp, signUpUser } from './helpers.js';
import { Authenticator } from './support/authenticator.js';

const INV = 'https://inventory.example.com';
let hub: FastifyInstance;
let hubUrl: string;
let app: FastifyInstance;
let admin: Record<string, string>;
const codes = new Map<string, { user: string; nonce: string; challenge: string; redirect: string }>();
const hints: string[] = [];
let signedIn = 'USR-2';
const hubAuth = new Authenticator(INV, 'example.com');
let token = 'umb_token-1';
let users: Record<string, unknown>[] = [];

const key = () =>
  `umbid1.${Buffer.from(JSON.stringify({ hub: hubUrl, client_id: 'umb-inv', client_secret: 'secret-1', token: 'umb_token-1' })).toString('base64url')}`;

beforeAll(async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const signer = await importJWK({ ...(privateKey.export({ format: 'jwk' }) as object), alg: 'RS256' }, 'RS256');
  hub = Fastify();
  hub.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, b, done) => done(null, Object.fromEntries(new URLSearchParams(b as string))));
  hub.get('/.well-known/openid-configuration', async () => ({
    issuer: hubUrl,
    authorization_endpoint: `${hubUrl}/oauth2/authorize`,
    token_endpoint: `${hubUrl}/oauth2/token`,
    jwks_uri: `${hubUrl}/oauth2/jwks`,
  }));
  hub.get('/oauth2/jwks', async () => ({ keys: [jwk] }));
  hub.get('/oauth2/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    hints.push(q.idp_hint ?? '');
    const code = `c${codes.size}`;
    codes.set(code, { user: signedIn, nonce: q.nonce, challenge: q.code_challenge, redirect: q.redirect_uri });
    return reply.redirect(`${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}`);
  });
  hub.post('/oauth2/token', async (req, reply) => {
    const b = req.body as Record<string, string>;
    if (b.client_id !== 'umb-inv' || b.client_secret !== 'secret-1') return reply.status(401).send({ error: 'invalid_client' });
    const c = codes.get(b.code);
    codes.delete(b.code);
    if (!c || c.redirect !== b.redirect_uri || createHash('sha256').update(b.code_verifier).digest('base64url') !== c.challenge)
      return reply.status(400).send({ error: 'invalid_grant' });
    const u = users.find((x) => x.id === c.user) as Record<string, unknown>;
    const idToken = await new SignJWT({ nonce: c.nonce, preferred_username: u.username, name: u.name, email: u.email, groups: u.groups, umbrella_role: u.role, umbrella_admin: u.admin, amr: ['hwk', 'user'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(hubUrl)
      .setAudience('umb-inv')
      .setSubject(String(u.id))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signer);
    return { id_token: idToken, access_token: 'at', token_type: 'Bearer' };
  });
  const etagged = (body: unknown) => async (req: { headers: Record<string, unknown> }, reply: { status: (n: number) => { send: (v?: unknown) => unknown }; header: (k: string, v: string) => void }) => {
    if (req.headers.authorization !== `Bearer ${token}`) return reply.status(401).send({ error: 'unauthorized' });
    const data = typeof body === 'function' ? (body as () => unknown)() : body;
    const tag = `"${createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)}"`;
    reply.header('etag', tag);
    if (req.headers['if-none-match'] === tag) return reply.status(304).send();
    return data;
  };
  hub.get(
    '/api/identity/v1/config',
    etagged({
      version: 1,
      issuer: 'x',
      application: { id: 'APP-2', name: 'Inventory DB', sync_passkeys: true },
      password_policy: { min_length: 14, require_digits: true, min_digits: 2, require_special: true, min_special: 1, require_mixed_case: true, letters: 'latin', max_age_days: 0, warn_days: 0, history_count: 5, block_common: true, lockout_attempts: 6, lockout_minutes: 30 },
      passkeys: { enabled: true, rp_id: 'example.com' },
      methods: [{ id: 'passkey', title: 'Passkey' }, { id: 'ldap', title: 'Active Directory' }, { id: 'local', title: 'Umbrella' }],
    }) as never,
  );
  hub.get('/api/identity/v1/users', etagged(() => ({ users })) as never);
  hubUrl = await hub.listen({ port: 0, host: '127.0.0.1' });
  clearOidcCaches();

  users = [
    { id: 'USR-1', username: 'alice', email: 'alice@example.com', name: 'Alice', disabled: false, role: { id: 'R3', name: 'On-call engineer' }, admin: false, groups: ['cn=noc,dc=example,dc=com'], passkeys: [] },
    {
      id: 'USR-2', username: 'bob', email: 'bob@example.com', name: 'Bob', disabled: false, role: { id: 'admin', name: 'Administrator' }, admin: true, groups: [],
      passkeys: [{ id: 'PK-1', name: 'Windows Hello', credential_id: hubAuth.credentialId.toString('base64url'), public_key: hubAuth.cose().toString('base64url'), user_handle: Buffer.from('USR-2').toString('base64url'), sign_count: 0, aaguid: '', transports: ['internal'], backup_eligible: false, created_at: '2026-10-01T00:00:00Z' }],
    },
    { id: 'USR-3', username: 'carol', email: 'carol@example.com', name: 'Carol', disabled: true, role: { name: 'On-call engineer' }, admin: false, groups: [], passkeys: [] },
    { id: 'USR-4', username: 'dave', email: 'dave@example.com', name: 'Dave', disabled: false, role: { name: 'Guest' }, admin: false, groups: [], passkeys: [] },
  ];
  hubAuth.handle = Buffer.from('USR-2');

  app = await createTestApp();
  admin = (await signUpUser(app, 'boss@example.com')).headers;
  await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: admin }); // the first user becomes admin
  await app.inject({ method: 'PUT', url: '/api/v1/settings/public-url', headers: admin, payload: { public_url: INV } });
});

afterAll(async () => {
  await hub.close();
});

const inject = (method: string, url: string, payload?: unknown, headers: Record<string, string> = admin) =>
  app.inject({ method: method as 'GET', url: `/api/v1${url}`, payload: payload as object, headers });

describe('Umbrella Identity', () => {
  it('checks the key, connects and synchronizes users with mapped roles', async () => {
    const check = (await inject('POST', '/settings/identity/check', { key: key() })).json();
    expect(check.application).toBe('Inventory DB');
    expect(check.passkeys_here).toBe(true);
    expect((await inject('POST', '/settings/identity/check', { key: 'umbid1.nope' })).json().error).toBe('IDENTITY_KEY');
    const res = await inject('PUT', '/settings/identity', {
      key: key(),
      role_map: [{ match: 'On-call engineer', role: 'editor' }],
      admin_role: 'admin',
      default_role: 'none',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status.ok).toBe(true);
    const roles = (await app.inject({ method: 'GET', url: '/api/v1/netbox/roles', headers: admin })).json() as unknown;
    const list = (Array.isArray(roles) ? roles : ((roles as { results?: unknown[] }).results ?? [])) as { email: string; role: string }[];
    const byEmail = Object.fromEntries(list.map((r) => [r.email, r.role]));
    expect(byEmail['alice@example.com']).toBe('editor');
    expect(byEmail['bob@example.com']).toBe('admin');
    expect(byEmail['carol@example.com']).toBeUndefined();
    expect(byEmail['dave@example.com']).toBeUndefined();
  });

  it('takes the password policy from the hub and keeps it read-only', async () => {
    const p = (await inject('GET', '/settings/password-policy')).json();
    expect(p.policy.min_length).toBe(14);
    expect(p.managed_by_hub).toBe(true);
    expect((await inject('PUT', '/settings/password-policy', { ...p.policy, min_length: 8 })).statusCode).toBe(409);
  });

  it('shows the hub methods and signs in through the hub with idp_hint', async () => {
    const m = (await app.inject({ method: 'GET', url: '/api/v1/auth/methods' })).json();
    expect(m.passkeys).toBe(true);
    expect(m.umbrella.methods).toHaveLength(3);
    signedIn = 'USR-2';
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/umbrella/start?method=passkey&return=/dcim/devices' });
    expect(start.statusCode).toBe(302);
    const cookie = String(start.headers['set-cookie']).split(';')[0];
    const atHub = await fetch(String(start.headers.location), { redirect: 'manual' });
    expect(hints.at(-1)).toBe('passkey');
    const back = new URL(atHub.headers.get('location')!);
    expect(back.pathname).toBe('/api/auth/umbrella/callback');
    const done = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie } });
    expect(done.statusCode).toBe(302);
    const loc = String(done.headers.location);
    expect(loc).toMatch(/^\/signin#sso_token=/);
    const tok = decodeURIComponent(/sso_token=([^&]+)/.exec(loc)![1]);
    expect(decodeURIComponent(/return=([^&]+)/.exec(loc)![1])).toBe('/dcim/devices');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${tok}` } })).json();
    expect(me.user.email).toBe('bob@example.com');
    expect(me.account.source).toBe('umbrella');
  });

  it('signs in with the passkey registered in the hub', async () => {
    const begin = await app.inject({ method: 'POST', url: '/api/v1/auth/passkey/begin', headers: { origin: INV } });
    expect(begin.statusCode).toBe(200);
    const { ceremony, options } = begin.json();
    const fin = await app.inject({ method: 'POST', url: '/api/v1/auth/passkey/finish', payload: { ceremony, credential: hubAuth.get(options) } });
    expect(fin.statusCode).toBe(200);
    expect(fin.json().user.email).toBe('bob@example.com');
    const replay = await app.inject({ method: 'POST', url: '/api/v1/auth/passkey/finish', payload: { ceremony, credential: hubAuth.get(options) } });
    expect(replay.statusCode).toBe(400);
  });

  it('disables people who leave the hub', async () => {
    users = users.filter((u) => u.id !== 'USR-1');
    const s = (await inject('POST', '/settings/identity/sync')).json();
    expect(s.status.disabled).toBe(1);
    token = 'umb_other';
    const bad = (await inject('POST', '/settings/identity/sync')).json();
    expect(bad.status.ok).toBe(false);
    token = 'umb_token-1';
  });
});

describe('local passkeys, history and lockout', () => {
  it('registers and signs in with a passkey of the local account', async () => {
    await inject('DELETE', '/settings/identity');
    expect((await inject('PUT', '/settings/passkeys', { enabled: true, rp_id: 'example.com' })).statusCode).toBe(200);
    const auth = new Authenticator(INV, 'example.com');
    const begin = await app.inject({ method: 'POST', url: '/api/v1/auth/me/passkeys/begin', headers: { ...admin, origin: INV } });
    expect(begin.statusCode).toBe(200);
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/me/passkeys/finish', headers: admin, payload: { ceremony: begin.json().ceremony, credential: auth.create(begin.json().options), name: 'YubiKey' } });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().name).toBe('YubiKey');
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/passkey/begin', headers: { origin: 'https://evil.example.org' } })).statusCode).toBe(400);
    const b = (await app.inject({ method: 'POST', url: '/api/v1/auth/passkey/begin', headers: { origin: INV } })).json();
    auth.skipUV = true;
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/passkey/finish', payload: { ceremony: b.ceremony, credential: auth.get(b.options) } })).statusCode).toBe(401);
    auth.skipUV = false;
    const b2 = (await app.inject({ method: 'POST', url: '/api/v1/auth/passkey/begin', headers: { origin: INV } })).json();
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/passkey/finish', payload: { ceremony: b2.ceremony, credential: auth.get(b2.options) } });
    expect(ok.json().user.email).toBe('boss@example.com');
  });

  it('refuses common and reused passwords, locks after failed sign-ins', async () => {
    const p = (await inject('GET', '/settings/password-policy')).json().policy;
    await inject('PUT', '/settings/password-policy', { ...p, min_length: 12, min_digits: 1, history_count: 3, lockout_attempts: 3, lockout_minutes: 10 });
    const change = (current: string, next: string) =>
      app.inject({ method: 'POST', url: '/api/v1/auth/password', payload: { email: 'boss@example.com', password: current, newPassword: next } });
    const common = await change('Correct-Horse-9!', 'Qwerty123456!');
    expect(common.json().details.violations).toContain('common');
    expect((await change('Correct-Horse-9!', 'Battery-Staple-42')).statusCode).toBe(200);
    expect((await change('Battery-Staple-42', 'Another-Staple-43')).statusCode).toBe(200);
    const reused = await change('Another-Staple-43', 'Correct-Horse-9!');
    expect(reused.json().details.violations).toContain('history');
    for (let i = 0; i < 3; i++) await app.inject({ method: 'POST', url: '/api/v1/auth/signin', payload: { email: 'boss@example.com', password: 'wrong' } });
    const locked = await app.inject({ method: 'POST', url: '/api/v1/auth/signin', payload: { email: 'boss@example.com', password: 'Another-Staple-43' } });
    expect(locked.statusCode).toBe(429);
  });
});
