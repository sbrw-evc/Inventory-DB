/** LDAP / AD sign-in against a fake directory, and the LDAP settings page. */
import type { FastifyInstance } from 'fastify';
import { InvalidCredentialsError, NoSuchObjectError } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setLdapFactory, type LdapConnection } from '../src/auth/ldap.js';
import { getDb } from '../src/db/index.js';
import { getSecret } from '../src/system/secrets.js';
import { createTestApp, signUpUser } from './helpers.js';

const BASE = 'DC=corp,DC=example';
const ADMINS = `CN=Inventory Admins,OU=Groups,${BASE}`;
const SERVICE = `CN=svc-inventory,OU=Service,${BASE}`;
type Entry = { dn: string; password: string; attrs: Record<string, string>; groups: string[] };
const directory: Entry[] = [
  { dn: SERVICE, password: 'svc-pass', attrs: {}, groups: [] },
  { dn: `CN=Ivan Petrov,OU=Users,${BASE}`, password: 'ivan-pass', attrs: { sAMAccountName: 'ipetrov', displayName: 'Ivan Petrov', mail: 'Ivan.Petrov@corp.example' }, groups: [ADMINS] },
  { dn: `CN=Anna Smirnova,OU=Users,${BASE}`, password: 'anna-pass', attrs: { sAMAccountName: 'asmirnova', displayName: 'Anna Smirnova' }, groups: [] },
];
const exists = (dn: string) => dn === BASE || dn === ADMINS || directory.some((e) => e.dn === dn);
const unescape = (v: string) => v.replace(/\\([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
let binds: string[] = [];

/** Understands the searches the LDAP module makes. */
function fakeConnection(): LdapConnection {
  return {
    async startTLS() {},
    async bind(dn, password) {
      binds.push(dn);
      const e = directory.find((x) => x.dn === dn);
      if (!e || e.password !== password) throw new InvalidCredentialsError('Invalid credentials');
    },
    async search(base, { scope, filter }) {
      if (!exists(base)) throw new NoSuchObjectError('No such object');
      if (scope === 'base') {
        const nested = /memberOf:1\.2\.840\.113556\.1\.4\.1941:=(.+)\)$/.exec(filter);
        if (nested) return { searchEntries: directory.find((e) => e.dn === base)?.groups.includes(unescape(nested[1])) ? [{ dn: base }] : [] };
        return { searchEntries: [{ dn: base }] };
      }
      const m = /sAMAccountName=([^)]*)\)/.exec(filter);
      const name = m ? unescape(m[1]) : '';
      return { searchEntries: directory.filter((e) => e.attrs.sAMAccountName?.toLowerCase() === name.toLowerCase()).map((e) => ({ dn: e.dn, ...e.attrs })) };
    },
    async unbind() {},
  };
}

let app: FastifyInstance;
let admin: Record<string, string>;
const config = { enabled: true, kind: 'ad', url: 'ldaps://dc.corp.example', bind_dn: SERVICE, base_dn: BASE, admin_group_dn: ADMINS };

const inject = (method: string, url: string, payload?: unknown, headers = admin) => app.inject({ method: method as 'GET', url: `/api/v1${url}`, payload: payload as object, headers });

beforeAll(async () => {
  setLdapFactory(() => fakeConnection());
  app = await createTestApp();
  admin = (await signUpUser(app, 'local.admin@example.com')).headers;
  await inject('GET', '/settings/ldap');
});
afterAll(() => setLdapFactory(null));

describe('LDAP / AD sign-in', () => {
  it('checks the service account, base DN, admin group and a test user', async () => {
    const bad = (await inject('POST', '/settings/ldap/test', { config, bind_password: 'wrong' })).json();
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/service account/);
    const res = (await inject('POST', '/settings/ldap/test', { config, bind_password: 'svc-pass', test_username: 'ipetrov', test_password: 'ivan-pass' })).json();
    expect(res).toMatchObject({ ok: true, probe: { tls: 'ldaps', admin_group: true, user_authenticated: true, user: { username: 'ipetrov', email: 'ivan.petrov@corp.example', admin: true } } });
  });

  it('saves the settings with the bind password in the secret store and keeps it when unchanged', async () => {
    expect((await inject('PUT', '/settings/ldap', { config })).statusCode).toBe(400);
    const saved = (await inject('PUT', '/settings/ldap', { config, bind_password: 'svc-pass' })).json();
    expect(saved).toMatchObject({ bind_password_set: true, config: { enabled: true, url: config.url, user_filter: expect.stringContaining('{username}') } });
    expect(await getSecret('directory/ldap', 'bind_password')).toBe('svc-pass');
    expect(JSON.stringify(getDb().prepare("SELECT value FROM nc_settings WHERE key = 'directory.ldap'").get())).not.toContain('svc-pass');
    expect((await inject('PUT', '/settings/ldap', { config: { ...config, admin_group_dn: ADMINS } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/providers' })).json()).toEqual({ ldap: true, entra: false });
  });

  it('signs directory users in, creates their accounts and makes admin group members admins', async () => {
    binds = [];
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signin', payload: { email: 'ipetrov', password: 'ivan-pass' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: 'ivan.petrov@corp.example', name: 'Ivan Petrov' });
    expect(binds).toEqual([SERVICE, `CN=Ivan Petrov,OU=Users,${BASE}`]);
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${res.json().token}` } })).json();
    expect(me.account).toMatchObject({ source: 'ldap', admin: true, passwordExpiresAt: null });

    const anna = await app.inject({ method: 'POST', url: '/api/v1/auth/signin', payload: { email: 'asmirnova@corp.example', password: 'anna-pass' } });
    expect(anna.json().user.email).toBe('asmirnova@corp.example');
    const again = await app.inject({ method: 'POST', url: '/api/v1/auth/signin', payload: { email: 'asmirnova', password: 'anna-pass' } });
    expect(again.json().user.id).toBe(anna.json().user.id);

    for (const payload of [
      { email: 'asmirnova', password: 'wrong' },
      { email: 'nobody', password: 'x' },
      { email: 'a*', password: 'anna-pass' },
    ])
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/signin', payload })).statusCode).toBe(401);
  });

  it('takes the admin role back when the user leaves the admin group', async () => {
    directory[1].groups = [];
    await app.inject({ method: 'POST', url: '/api/v1/auth/signin', payload: { email: 'ipetrov', password: 'ivan-pass' } });
    const role = getDb().prepare("SELECT r.role FROM nb_roles r JOIN nc_users u ON u.id = r.user_id WHERE u.email = 'ivan.petrov@corp.example'").get();
    expect(role).toEqual({ role: 'viewer' });
  });

  it('never signs a directory user into a local account with the same email', async () => {
    await signUpUser(app, 'clash@corp.example');
    directory.push({ dn: `CN=Clash,OU=Users,${BASE}`, password: 'p', attrs: { sAMAccountName: 'clash', mail: 'clash@corp.example' }, groups: [] });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signin', payload: { email: 'clash', password: 'p' } });
    expect(res.statusCode).toBe(409);
  });

  it('shows directory accounts and does not turn LDAP off without a local admin', async () => {
    const view = (await inject('GET', '/settings/ldap')).json();
    expect(view.users).toMatchObject({ total: 2, admins: 0 });
    expect(view.local_admins).toBe(1);
    getDb().prepare("UPDATE nc_users SET disabled = 1 WHERE email = 'local.admin@example.com'").run();
    const ivan = getDb().prepare("SELECT id FROM nc_users WHERE email = 'ivan.petrov@corp.example'").get() as { id: string };
    getDb().prepare("UPDATE nb_roles SET role = 'admin' WHERE user_id = ?").run(ivan.id);
    const token = (await app.inject({ method: 'POST', url: '/api/v1/auth/signin', payload: { email: 'ipetrov', password: 'ivan-pass' } })).json().token;
    const res = await inject('PUT', '/settings/ldap', { config: { enabled: false } }, { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(409);
  });
});
