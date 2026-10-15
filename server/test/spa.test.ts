/** Sign-in and access through SPA (a fake SPA in-process): OIDC with PKCE, user synchronization, roles, catalogue. */
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseKey } from '../src/auth/spa/connection.js';
import { clearOidcCaches } from '../src/auth/spa/oidc.js';
import { resetSpaSyncMemory, syncSpa } from '../src/auth/spa/sync.js';
import { getDb, newId, now } from '../src/db/index.js';
import { createTestApp } from './helpers.js';
import { startFakeSpa, type FakeSpa } from './support/fakeSpa.js';

const INV = 'https://inventory.example.com';
let spa: FakeSpa;
let app: FastifyInstance;

const person = (id: string, username: string, roles: string[], extra: Partial<FakeSpa['users'][number]> = {}) => ({
  id,
  username,
  email: `${username}@example.com`,
  name: username[0].toUpperCase() + username.slice(1),
  disabled: false,
  roles,
  groups: ['noc'],
  source: 'ldap',
  updated_at: '2026-10-15T12:00:00Z',
  ...extra,
});

const cookieOf = (setCookie: string | string[] | undefined) => String(Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? '')).split(';')[0];

/** The whole browser round trip: start → SPA authorize → callback. Returns where the callback sent the browser. */
async function signIn(opts: { returnTo?: string; spoilState?: boolean; dropCookie?: boolean; query?: string } = {}) {
  const start = await app.inject({ method: 'GET', url: `/api/auth/spa/start?return=${encodeURIComponent(opts.returnTo ?? '/dcim/sites')}${opts.query ?? ''}` });
  expect(start.statusCode).toBe(302);
  const setCookie = start.headers['set-cookie'];
  const authorize = String(start.headers.location);
  const back = await fetch(authorize, { redirect: 'manual' });
  expect(back.status).toBe(302);
  const cb = new URL(back.headers.get('location')!);
  expect(`${cb.origin}${cb.pathname}`).toBe(`${INV}/api/auth/spa/callback`);
  if (opts.spoilState) cb.searchParams.set('state', `${cb.searchParams.get('state')}x`);
  const res = await app.inject({ method: 'GET', url: `${cb.pathname}${cb.search}`, headers: opts.dropCookie ? {} : { cookie: cookieOf(setCookie) } });
  const location = String(res.headers.location ?? '');
  const hash = new URLSearchParams(location.split('#')[1] ?? '');
  const error = new URL(location, INV).searchParams.get('sso_error');
  return { res, start, setCookie, authorize: new URL(authorize), callbackUrl: cb, location, token: hash.get('sso_token'), ret: hash.get('return'), error };
}

const me = (token: string) => app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  spa = await startFakeSpa();
  process.env.SPA_PUBLIC_URL = INV;
});

afterAll(async () => {
  delete process.env.SPA_CONNECTION_KEY;
  delete process.env.SPA_CONNECTION_KEY_FILE;
  delete process.env.SPA_PUBLIC_URL;
  await spa.close();
});

beforeEach(async () => {
  clearOidcCaches();
  resetSpaSyncMemory();
  spa.users = [person('usr_admin', 'ada', ['admin']), person('usr_bob', 'bob', ['viewer', 'editor']), person('usr_carl', 'carl', ['viewer'])];
  spa.signedIn = 'usr_admin';
  spa.tamper = {};
  spa.deny = false;
  spa.published = [];
  spa.calls = [];
  spa.authorizeQueries = [];
  process.env.SPA_CONNECTION_KEY = spa.key();
  app = await createTestApp();
}, 60_000);

afterEach(async () => {
  await app.close();
});

describe('connection key', () => {
  it('parses spa1. keys and rejects anything else', () => {
    expect(parseKey(spa.key())).toEqual({ issuer: spa.url, client_id: spa.clientId, client_secret: spa.clientSecret, token: spa.token });
    expect(() => parseKey('umbid1.abc')).toThrow(/SPA connection key/);
    expect(() => parseKey(`spa1.${Buffer.from('{"issuer":"ftp://x","client_id":"a","client_secret":"b","token":"c"}').toString('base64url')}`)).toThrow();
  });

  it('shows "not connected" without a key, and refuses to start a sign-in', async () => {
    delete process.env.SPA_CONNECTION_KEY;
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/spa' })).json()).toEqual({ connected: false });
    const start = await app.inject({ method: 'GET', url: '/api/auth/spa/start' });
    expect(start.statusCode).toBe(302);
    expect(String(start.headers.location)).toMatch(/^\/signin\?sso_error=This%20application%20is%20not%20connected%20to%20SPA/);
  });

  it('reads the key from SPA_CONNECTION_KEY_FILE', async () => {
    delete process.env.SPA_CONNECTION_KEY;
    const dir = mkdtempSync(join(tmpdir(), 'spa-key-'));
    writeFileSync(join(dir, 'key'), `${spa.key()}\n`);
    process.env.SPA_CONNECTION_KEY_FILE = join(dir, 'key');
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/auth/spa' })).json()).toMatchObject({ connected: true, issuer: spa.url });
    } finally {
      delete process.env.SPA_CONNECTION_KEY_FILE;
    }
  });
});

describe('sign-in with SPA', () => {
  it('runs the code flow with PKCE S256, nonce and a signed state, then starts an Inventory DB session', async () => {
    const r = await signIn();
    const q = Object.fromEntries(r.authorize.searchParams);
    expect(`${r.authorize.origin}${r.authorize.pathname}`).toBe(`${spa.url}/oauth2/authorize`);
    expect(q).toMatchObject({ response_type: 'code', client_id: spa.clientId, redirect_uri: `${INV}/api/auth/spa/callback`, code_challenge_method: 'S256' });
    expect(q.scope.split(' ')).toEqual(['openid', 'profile', 'email', 'groups', 'roles']);
    expect(q.nonce.length).toBeGreaterThan(20);
    expect(q.code_challenge).toMatch(/^[\w-]{43}$/);
    const cookie = String(r.setCookie);
    expect(cookie).toMatch(/^idb_spa=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/auth/spa/');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('Secure');
    // The verifier is not in the URL.
    expect(r.authorize.toString()).not.toContain(decodeURIComponent(cookieOf(r.setCookie).split('=')[1]));

    expect(r.location.startsWith('/signin#sso_token=')).toBe(true);
    expect(r.ret).toBe('/dcim/sites');
    const m = (await me(r.token!)).json();
    expect(m.user).toMatchObject({ email: 'ada@example.com', name: 'Ada' });
    expect(m.account).toMatchObject({ source: 'spa', username: 'ada', admin: true, role: 'admin', spa: { issuer: spa.url } });
    const row = getDb().prepare('SELECT source, external_id, last_sign_in_at FROM nc_users WHERE id = ?').get(m.user.id) as Record<string, string>;
    expect(row).toMatchObject({ source: 'spa', external_id: 'usr_admin' });
    expect(row.last_sign_in_at).toBeTruthy();
  });

  it('passes login_hint, idp_hint and prompt=login on, and only follows same-site return paths', async () => {
    const r = await signIn({ returnTo: '//evil.example.com/x', query: '&login_hint=ada&idp_hint=passkey&prompt=login' });
    expect(Object.fromEntries(r.authorize.searchParams)).toMatchObject({ login_hint: 'ada', idp_hint: 'passkey', prompt: 'login' });
    expect(r.ret).toBe('/');
    const odd = await signIn({ query: '&idp_hint=telegram&prompt=none' });
    expect(odd.authorize.searchParams.has('idp_hint')).toBe(false);
    expect(odd.authorize.searchParams.has('prompt')).toBe(false);
  });

  it('maps the highest DCIM/IPAM role of the roles claim', async () => {
    spa.signedIn = 'usr_bob';
    const m = (await me((await signIn()).token!)).json();
    expect(m.account).toMatchObject({ role: 'editor', admin: false });
    const write = await app.inject({ method: 'POST', url: '/api/v1/dcim/sites', headers: { authorization: `Bearer ${(await signIn()).token}` }, payload: { name: 'S', slug: 's' } });
    expect(write.statusCode).toBe(201);
  });

  it('refuses a wrong or replayed state and a missing verifier cookie', async () => {
    expect((await signIn({ spoilState: true })).error).toMatch(/took too long/);
    expect((await signIn({ dropCookie: true })).error).toMatch(/took too long/);
    // Replay of a finished callback.
    const ok = await signIn();
    expect(ok.token).toBeTruthy();
    const again = await app.inject({ method: 'GET', url: `${ok.callbackUrl.pathname}${ok.callbackUrl.search}`, headers: { cookie: cookieOf(ok.setCookie) } });
    expect(String(again.headers.location)).toMatch(/sso_error=/);
    expect(getDb().prepare('SELECT COUNT(*) n FROM nc_users').get()).toMatchObject({ n: 1 });
  });

  it.each([
    ['nonce', { nonce: 'other-nonce' }],
    ['audience', { aud: 'app_someone_else' }],
    ['issuer', { iss: 'https://evil.example.com' }],
    ['signature', { foreignKey: true }],
    ['expiry', { expired: true }],
    ['algorithm', { alg: 'HS256' as const }],
  ])('rejects an ID token with a wrong %s', async (_what, tamper) => {
    spa.tamper = tamper;
    const r = await signIn();
    expect(r.token).toBeNull();
    expect(r.error).toBe('SPA sign-in could not be completed. Try again.');
    expect(getDb().prepare('SELECT COUNT(*) n FROM nc_users').get()).toMatchObject({ n: 0 });
  });

  it('shows access_denied from SPA, and refuses an ID token without a role of ours', async () => {
    spa.deny = true;
    expect((await signIn()).error).toBe('You have no access to Inventory DB. Ask an SPA administrator for a role.');
    spa.users[0].roles = ['operator'];
    expect((await signIn()).error).toBe('You have no access to Inventory DB. Ask an SPA administrator for a role.');
    expect(getDb().prepare('SELECT COUNT(*) n FROM nc_users').get()).toMatchObject({ n: 0 });
  });

  it('binds a record from before SPA once (by user name or e-mail) and keeps its ID and base memberships', async () => {
    const db = getDb();
    const legacy = newId('usr');
    db.prepare("INSERT INTO nc_users (id, email, name, created_at, source, username) VALUES (?, 'ADA@example.com', 'Old Ada', ?, 'local', NULL)").run(legacy, now());
    const base = newId('base');
    db.prepare("INSERT INTO nc_bases (id, title, created_at) VALUES (?, 'Old base', ?)").run(base, now());
    db.prepare("INSERT INTO nc_base_members (base_id, user_id, role) VALUES (?, ?, 'owner')").run(base, legacy);

    const m = (await me((await signIn()).token!)).json();
    expect(m.user.id).toBe(legacy);
    expect(m.user.name).toBe('Ada');
    expect(db.prepare('SELECT source, external_id FROM nc_users WHERE id = ?').get(legacy)).toEqual({ source: 'spa', external_id: 'usr_admin' });
    const bases = await app.inject({ method: 'GET', url: '/api/v1/bases', headers: { authorization: `Bearer ${(await signIn()).token}` } });
    expect(bases.json().map((b: { id: string }) => b.id)).toContain(base);

    // Then by sub only: a new e-mail in SPA does not move the binding, and another old record with that e-mail stays apart.
    const other = newId('usr');
    db.prepare("INSERT INTO nc_users (id, email, name, created_at, source) VALUES (?, 'ada.new@example.com', 'Someone', ?, 'local')").run(other, now());
    spa.users[0].email = 'ada.new@example.com';
    expect((await me((await signIn()).token!)).json().user).toMatchObject({ id: legacy, email: 'ada.new@example.com' });
    expect(db.prepare('SELECT source FROM nc_users WHERE id = ?').get(other)).toEqual({ source: 'local' });
  });

  it('signs out through SPA', async () => {
    await syncSpa('test');
    const out = await app.inject({ method: 'GET', url: '/api/auth/spa/logout' });
    expect(out.statusCode).toBe(302);
    const to = new URL(String(out.headers.location));
    expect(`${to.origin}${to.pathname}`).toBe(`${spa.url}/oauth2/logout`);
    expect(Object.fromEntries(to.searchParams)).toEqual({ post_logout_redirect_uri: `${INV}/`, client_id: spa.clientId });
  });
});

describe('synchronization', () => {
  it('publishes the role catalogue and creates, updates and disables users with ETags', async () => {
    const legacy = newId('usr');
    getDb().prepare("INSERT INTO nc_users (id, email, name, created_at, source, username) VALUES (?, 'old@example.com', 'Old', ?, 'ldap', 'old')").run(legacy, now());
    const carlByName = newId('usr');
    getDb().prepare("INSERT INTO nc_users (id, email, name, created_at, source, username) VALUES (?, 'c.arl@corp.example.com', 'Carl L', ?, 'ldap', 'CARL')").run(carlByName, now());

    let s = await syncSpa('test');
    expect(s).toMatchObject({ ok: true, counts: { users: 3, created: 2, updated: 1, matched: 1, disabled: 1 } });
    expect(spa.published).toEqual([
      {
        roles: [
          { id: 'admin', name: 'Administrator', description: expect.any(String) },
          { id: 'editor', name: 'Editor', description: expect.any(String) },
          { id: 'viewer', name: 'Viewer', description: expect.any(String) },
        ],
        default: 'viewer',
      },
    ]);
    expect(s.config?.account_url).toBe(`${spa.url}/profile`);
    const users = () =>
      Object.fromEntries(
        (getDb().prepare("SELECT u.id, u.external_id, u.email, u.disabled, r.role FROM nc_users u LEFT JOIN nb_roles r ON r.user_id = u.id").all() as Record<string, string>[]).map((r) => [
          r.external_id ?? r.id,
          r,
        ]),
      );
    let u = users();
    expect(u.usr_admin).toMatchObject({ role: 'admin', disabled: 0 });
    expect(u.usr_bob).toMatchObject({ role: 'editor', disabled: 0 });
    expect(u.usr_carl).toMatchObject({ id: carlByName, role: 'viewer', disabled: 0, email: 'carl@example.com' });
    expect(getDb().prepare('SELECT disabled FROM nc_users WHERE id = ?').get(legacy)).toEqual({ disabled: 1 });

    // Nothing changed: 304.
    spa.calls = [];
    s = await syncSpa('test');
    expect(spa.calls.filter((c) => c.path === '/api/spa/v1/users')).toEqual([expect.objectContaining({ status: 304, etag: expect.stringMatching(/^"/) })]);
    expect(spa.published).toHaveLength(1);

    // Bob loses editor, Carl is disabled, Ada leaves the application; a new person arrives.
    spa.users = [person('usr_bob', 'bob', ['viewer'], { name: 'Robert' }), person('usr_carl', 'carl', ['viewer'], { disabled: true }), person('usr_dan', 'dan', ['editor'])];
    s = await syncSpa('test');
    expect(s.counts).toMatchObject({ users: 2, created: 1, disabled: 2 });
    u = users();
    expect(u.usr_bob).toMatchObject({ role: 'viewer', disabled: 0 });
    expect(u.usr_carl).toMatchObject({ disabled: 1 });
    expect(u.usr_admin).toMatchObject({ disabled: 1 });
    expect(u.usr_dan).toMatchObject({ role: 'editor', disabled: 0 });
  });

  it('ends the sessions and API tokens of a person SPA disables', async () => {
    spa.signedIn = 'usr_bob';
    const { token } = await signIn();
    const headers = { authorization: `Bearer ${token}` };
    const apiToken = (await app.inject({ method: 'POST', url: '/api/v1/tokens', headers, payload: { description: 'CI' } })).json().token;
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'xc-token': apiToken } })).statusCode).toBe(200);

    spa.users[1].disabled = true;
    await syncSpa('test');
    expect((await me(token!)).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'xc-token': apiToken } })).statusCode).toBe(401);

    // Enabled again: a new sign-in works, the old session and token stay dead.
    spa.users[1].disabled = false;
    await syncSpa('test');
    await new Promise((r) => setTimeout(r, 1100));
    const fresh = await signIn();
    expect((await me(fresh.token!)).statusCode).toBe(200);
    expect((await me(token!)).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'xc-token': apiToken } })).statusCode).toBe(401);
  });

  it('reports a replaced key (401) as an error and keeps the users', async () => {
    await syncSpa('test');
    process.env.SPA_CONNECTION_KEY = `spa1.${Buffer.from(JSON.stringify({ issuer: spa.url, client_id: spa.clientId, client_secret: 'x', token: 'revoked' })).toString('base64url')}`;
    const s = await syncSpa('test');
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/refused the connection key/);
    expect(getDb().prepare('SELECT COUNT(*) n FROM nc_users WHERE disabled = 0').get()).toMatchObject({ n: 3 });
  });
});

describe('settings', () => {
  it('shows the SPA connection to administrators and synchronizes on request', async () => {
    const admin = { authorization: `Bearer ${(await signIn()).token}` };
    spa.signedIn = 'usr_carl';
    const viewer = { authorization: `Bearer ${(await signIn()).token}` };
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/spa', headers: viewer })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/settings/spa/sync', headers: viewer })).statusCode).toBe(403);

    const before = (await app.inject({ method: 'GET', url: '/api/v1/settings/spa', headers: admin })).json();
    expect(before).toMatchObject({ connected: true, key_source: 'environment', issuer: spa.url, client_id: spa.clientId, redirect_uri: `${INV}/api/auth/spa/callback`, last_sync: null });
    expect(JSON.stringify(before)).not.toContain(spa.clientSecret);
    expect(JSON.stringify(before)).not.toContain(spa.token);

    const after = (await app.inject({ method: 'POST', url: '/api/v1/settings/spa/sync', headers: admin })).json();
    expect(after).toMatchObject({
      ok: true,
      application: { id: spa.clientId, name: 'Inventory DB', type: 'inventory-db' },
      account_url: `${spa.url}/profile`,
      sign_out_url: `${spa.url}/oauth2/logout`,
      counts: { users: 3 },
      users: { active: 3, bound: 3, admins: 1 },
      roles_published_at: expect.any(String),
      last_sync: expect.any(String),
    });
    const list = (await app.inject({ method: 'GET', url: '/api/v1/settings/spa/users', headers: admin })).json();
    expect(list.map((u: { username: string; role: string }) => `${u.username}:${u.role}`).sort()).toEqual(['ada:admin', 'bob:editor', 'carl:viewer']);

    const m = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: admin })).json();
    expect(m.account.spa.account_url).toBe(`${spa.url}/profile`);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/spa' })).json()).toEqual({ connected: true, issuer: spa.url, application: 'Inventory DB' });
  });

  it('has no local sign-in, sign-up, password or directory endpoints any more', async () => {
    for (const [method, url] of [
      ['POST', '/api/v1/auth/signup'],
      ['POST', '/api/v1/auth/signin'],
      ['POST', '/api/v1/auth/password'],
      ['GET', '/api/v1/auth/providers'],
      ['GET', '/api/v1/auth/methods'],
      ['POST', '/api/v1/auth/passkey/begin'],
      ['GET', '/api/v1/auth/entra/start'],
      ['GET', '/api/v1/auth/umbrella/start'],
      ['GET', '/api/v1/settings/ldap'],
      ['GET', '/api/v1/settings/entra'],
      ['GET', '/api/v1/settings/password-policy'],
      ['GET', '/api/v1/settings/identity'],
      ['GET', '/api/v1/settings/passkeys'],
    ] as const)
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(404);
  });
});
