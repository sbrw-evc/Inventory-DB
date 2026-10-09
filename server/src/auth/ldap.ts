/**
 * Sign-in through LDAP / Active Directory, the way Umbrella does it: a service account searches for the user under
 * the base DN, then the user's own password is checked with a bind as that entry. Membership in the administrators
 * group (nested groups in AD) makes the user a DCIM/IPAM admin.
 */
import { Client, InvalidCredentialsError, NoSuchObjectError } from 'ldapts';
import type { ConnectionOptions } from 'node:tls';

export type LdapKind = 'ad' | 'openldap';

export interface LdapConfig {
  enabled: boolean;
  kind: LdapKind;
  url: string;
  start_tls: boolean;
  skip_verify: boolean;
  ca_cert: string;
  bind_dn: string;
  base_dn: string;
  user_filter: string;
  username_attr: string;
  name_attr: string;
  email_attr: string;
  admin_group_dn: string;
}

export interface LdapIdentity {
  dn: string;
  username: string;
  name: string;
  email: string;
  admin: boolean;
}

export interface LdapProbe {
  server: string;
  tls: 'ldaps' | 'starttls' | 'none';
  base_dn: string;
  admin_group: boolean;
  user_authenticated: boolean;
  user?: LdapIdentity;
}

export const LDAP_DEFAULTS: Record<LdapKind, Pick<LdapConfig, 'user_filter' | 'username_attr' | 'name_attr' | 'email_attr'>> = {
  ad: {
    user_filter: '(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))',
    username_attr: 'sAMAccountName',
    name_attr: 'displayName',
    email_attr: 'mail',
  },
  openldap: {
    user_filter: '(&(objectClass=inetOrgPerson)(uid={username}))',
    username_attr: 'uid',
    name_attr: 'cn',
    email_attr: 'mail',
  },
};

export const defaultLdapConfig = (kind: LdapKind = 'ad'): LdapConfig => ({
  enabled: false,
  kind,
  url: '',
  start_tls: false,
  skip_verify: false,
  ca_cert: '',
  bind_dn: '',
  base_dn: '',
  admin_group_dn: '',
  ...LDAP_DEFAULTS[kind],
});

/** In AD, membership through nested groups (LDAP_MATCHING_RULE_IN_CHAIN). */
const AD_NESTED_MEMBER = '1.2.840.113556.1.4.1941';
const TIMEOUT_MS = 10_000;

/** The calls this module makes; tests replace the client with a fake directory. */
export interface LdapConnection {
  startTLS(options?: ConnectionOptions): Promise<void>;
  bind(dn: string, password: string): Promise<void>;
  search(base: string, options: { scope: 'base' | 'sub'; filter: string; attributes: string[]; sizeLimit?: number }): Promise<{ searchEntries: Record<string, unknown>[] }>;
  unbind(): Promise<void>;
}

type Factory = (url: string, tls: ConnectionOptions) => LdapConnection;
const defaultFactory: Factory = (url, tlsOptions) =>
  new Client({ url, timeout: TIMEOUT_MS, connectTimeout: TIMEOUT_MS, tlsOptions }) as unknown as LdapConnection;
let factory: Factory = defaultFactory;

/** Tests: swap the LDAP client. */
export function setLdapFactory(f: Factory | null) {
  factory = f ?? defaultFactory;
}

export function tlsMode(c: Pick<LdapConfig, 'url' | 'start_tls'>): LdapProbe['tls'] {
  return c.url.trim().toLowerCase().startsWith('ldaps://') ? 'ldaps' : c.start_tls ? 'starttls' : 'none';
}

/** RFC 4515 escaping of a value inside a search filter. */
export const escapeFilter = (v: string) => v.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

const ATTR = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

/** Validation for saving and testing; returns the trimmed config. */
export function normalizeLdap(c: LdapConfig): LdapConfig {
  const t = (s: string | undefined) => (s ?? '').trim();
  const out: LdapConfig = {
    ...c,
    url: t(c.url),
    ca_cert: t(c.ca_cert),
    bind_dn: t(c.bind_dn),
    base_dn: t(c.base_dn),
    user_filter: t(c.user_filter) || LDAP_DEFAULTS[c.kind].user_filter,
    username_attr: t(c.username_attr) || LDAP_DEFAULTS[c.kind].username_attr,
    name_attr: t(c.name_attr) || LDAP_DEFAULTS[c.kind].name_attr,
    email_attr: t(c.email_attr) || LDAP_DEFAULTS[c.kind].email_attr,
    admin_group_dn: t(c.admin_group_dn),
  };
  if (!out.enabled) return out;
  if (!/^ldaps?:\/\/[^\s/]+/i.test(out.url)) throw new Error('The server address must look like ldaps://dc.example.com:636 or ldap://dc.example.com');
  if (!out.bind_dn) throw new Error('The service account DN is required');
  if (!out.base_dn) throw new Error('The base DN is required');
  if (!out.user_filter.includes('{username}')) throw new Error('The user filter must contain {username}');
  for (const a of [out.username_attr, out.name_attr, out.email_attr]) if (!ATTR.test(a)) throw new Error(`Invalid attribute name: ${a}`);
  return out;
}

function value(entry: Record<string, unknown>, attr: string): string {
  const key = Object.keys(entry).find((k) => k.toLowerCase() === attr.toLowerCase());
  const v = key ? entry[key] : undefined;
  const first = Array.isArray(v) ? v[0] : v;
  if (first === undefined || first === null) return '';
  return Buffer.isBuffer(first) ? first.toString('utf8') : String(first);
}

/** user@corp.example from DC=corp,DC=example, for accounts without an email attribute. */
function domainOf(baseDn: string) {
  const parts = [...baseDn.matchAll(/(?:^|,)\s*DC=([^,]+)/gi)].map((m) => m[1].trim());
  return parts.length ? parts.join('.').toLowerCase() : 'ldap.local';
}

function checkUsername(u: string) {
  if (!u || u.length > 256 || /[\0\r\n]/.test(u)) throw new InvalidCredentialsError('Invalid username');
}

const tlsOf = (c: LdapConfig): ConnectionOptions => ({ rejectUnauthorized: !c.skip_verify, ...(c.ca_cert ? { ca: c.ca_cert } : {}) });

async function open(c: LdapConfig): Promise<LdapConnection> {
  const conn = factory(c.url, tlsOf(c));
  try {
    if (tlsMode(c) === 'starttls') await conn.startTLS(tlsOf(c));
    return conn;
  } catch (e) {
    await conn.unbind().catch(() => {});
    throw e;
  }
}

async function connect(c: LdapConfig, bindPassword: string): Promise<LdapConnection> {
  const conn = await open(c);
  try {
    await conn.bind(c.bind_dn, bindPassword);
    return conn;
  } catch (e) {
    await conn.unbind().catch(() => {});
    if (e instanceof InvalidCredentialsError) throw new Error(`The service account could not sign in (${c.bind_dn}): wrong DN or password`);
    throw e;
  }
}

async function findUser(conn: LdapConnection, c: LdapConfig, username: string) {
  const filter = c.user_filter.replaceAll('{username}', escapeFilter(username));
  const { searchEntries } = await conn.search(c.base_dn, {
    scope: 'sub',
    filter,
    attributes: [c.username_attr, c.name_attr, c.email_attr, 'userPrincipalName'],
    sizeLimit: 2,
  });
  if (searchEntries.length > 1) throw new Error(`More than one directory entry matches ${username}`);
  return searchEntries[0] ?? null;
}

async function isAdmin(conn: LdapConnection, c: LdapConfig, dn: string, username: string): Promise<boolean> {
  if (!c.admin_group_dn) return false;
  try {
    const res =
      c.kind === 'ad'
        ? await conn.search(dn, { scope: 'base', filter: `(memberOf:${AD_NESTED_MEMBER}:=${escapeFilter(c.admin_group_dn)})`, attributes: ['1.1'] })
        : await conn.search(c.admin_group_dn, {
            scope: 'base',
            filter: `(|(member=${escapeFilter(dn)})(uniqueMember=${escapeFilter(dn)})(memberUid=${escapeFilter(username)}))`,
            attributes: ['1.1'],
          });
    return res.searchEntries.length > 0;
  } catch (e) {
    if (e instanceof NoSuchObjectError) return false;
    throw new Error(`Administrators group check: ${(e as Error).message}`);
  }
}

function identity(c: LdapConfig, entry: Record<string, unknown>, username: string, admin: boolean): LdapIdentity {
  const dn = String(entry.dn);
  const login = value(entry, c.username_attr) || username;
  const email = (value(entry, c.email_attr) || value(entry, 'userPrincipalName') || `${login}@${domainOf(c.base_dn)}`).toLowerCase();
  return { dn, username: login, name: value(entry, c.name_attr) || login, email, admin };
}

/**
 * Checks a user's password against the directory. Returns null when the user is not in the directory or the
 * password is wrong (the caller answers "invalid login"); throws when the directory cannot be used.
 */
export async function ldapAuthenticate(c: LdapConfig, bindPassword: string, username: string, password: string): Promise<LdapIdentity | null> {
  checkUsername(username);
  // An empty password would be an "unauthenticated bind", which many servers accept.
  if (!password) return null;
  const conn = await connect(c, bindPassword);
  try {
    let entry = await findUser(conn, c, username);
    // user@domain typed for an AD account: try the part before @.
    if (!entry && username.includes('@')) entry = await findUser(conn, c, username.split('@')[0]);
    if (!entry) return null;
    const dn = String(entry.dn);
    const user = await open(c);
    try {
      await user.bind(dn, password);
    } catch (e) {
      if (e instanceof InvalidCredentialsError) return null;
      throw e;
    } finally {
      await user.unbind().catch(() => {});
    }
    return identity(c, entry, username, await isAdmin(conn, c, dn, username));
  } finally {
    await conn.unbind().catch(() => {});
  }
}

/** Settings page check: service account, base DN, administrators group and optionally a user's sign-in. */
export async function ldapTest(c: LdapConfig, bindPassword: string, testUser?: string, testPassword?: string): Promise<LdapProbe> {
  const probe: LdapProbe = { server: c.url, tls: tlsMode(c), base_dn: c.base_dn, admin_group: false, user_authenticated: false };
  const conn = await connect(c, bindPassword);
  try {
    try {
      await conn.search(c.base_dn, { scope: 'base', filter: '(objectClass=*)', attributes: ['1.1'] });
    } catch (e) {
      throw new Error(`Base DN ${c.base_dn}: ${(e as Error).message}`);
    }
    if (c.admin_group_dn) {
      try {
        await conn.search(c.admin_group_dn, { scope: 'base', filter: '(objectClass=*)', attributes: ['1.1'] });
        probe.admin_group = true;
      } catch (e) {
        throw new Error(`Administrators group ${c.admin_group_dn}: ${(e as Error).message}`);
      }
    }
  } finally {
    await conn.unbind().catch(() => {});
  }
  if (testUser) {
    const user = await ldapAuthenticate(c, bindPassword, testUser, testPassword ?? '');
    if (!user) throw new Error(`User ${testUser} was not found or the password is wrong`);
    probe.user_authenticated = true;
    probe.user = user;
  }
  return probe;
}

/** Status page check: the service account can sign in and read the base DN. */
export async function ldapPing(c: LdapConfig, bindPassword: string): Promise<void> {
  const conn = await connect(c, bindPassword);
  try {
    await conn.search(c.base_dn, { scope: 'base', filter: '(objectClass=*)', attributes: ['1.1'] });
  } finally {
    await conn.unbind().catch(() => {});
  }
}
