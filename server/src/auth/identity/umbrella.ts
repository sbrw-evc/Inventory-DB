/**
 * Umbrella Identity, the member side (docs/identity-federation.md): Inventory DB connects to Umbrella Monitoring with a
 * connection key, signs people in through it and synchronizes users, DCIM/IPAM roles, the password policy and passkeys
 * every five minutes. Settings key `identity.umbrella`; the client secret and the synchronization token live in the
 * secret store at `identity/umbrella`.
 */
import type { User } from '../../../../shared/src/index.js';
import { normalizePolicy, type PasswordPolicy } from '../../../../shared/src/passwordPolicy.js';
import { getDb } from '../../db/index.js';
import { HttpError } from '../../errors.js';
import type { NetboxRole } from '../../netbox/access.js';
import { logEvent } from '../../system/logbuf.js';
import { deleteSecret, getSecret, setSecret } from '../../system/secrets.js';
import { readSetting, writeSetting } from '../../system/settings.js';
import { accountByExternal, disableMissing, upsertAccount } from './accounts.js';
import { authUrl, exchange, newRequest, strings, verify, type Client, type Request } from './oidc.js';
import { hostWithin, replaceHubPasskeys } from './passkeys.js';

export const UMBRELLA_KEY = 'identity.umbrella';
const SECRET = 'identity/umbrella';
export const UMBRELLA_CALLBACK = '/api/auth/umbrella/callback';
const SYNC_EVERY_MS = 5 * 60_000;
const TIMEOUT_MS = 20_000;

export interface ConnectionKey {
  hub: string;
  client_id: string;
  client_secret: string;
  token: string;
}

export type MappedRole = NetboxRole | 'none';

export interface Mapping {
  match: string;
  role: NetboxRole;
}

export interface UmbrellaSettings {
  enabled: boolean;
  hub: string;
  client_id: string;
  application: string;
  role_map: Mapping[];
  admin_role: MappedRole;
  default_role: MappedRole;
  link_local: boolean;
  sso: boolean;
  sync_users: boolean;
  sync_policy: boolean;
  sync_passkeys: boolean;
  methods: { id: string; title: string }[];
  hub_passkeys: { enabled: boolean; rp_id: string };
  status: {
    last_sync?: string;
    ok: boolean;
    error?: string;
    users: number;
    created: number;
    updated: number;
    disabled: number;
    conflicts: string[];
    config_etag?: string;
    users_etag?: string;
  };
}

const defaults = (): UmbrellaSettings => ({
  enabled: false,
  hub: '',
  client_id: '',
  application: '',
  role_map: [],
  admin_role: 'admin',
  default_role: 'viewer',
  link_local: true,
  sso: true,
  sync_users: true,
  sync_policy: true,
  sync_passkeys: true,
  methods: [],
  hub_passkeys: { enabled: false, rp_id: '' },
  status: { ok: false, users: 0, created: 0, updated: 0, disabled: 0, conflicts: [] },
});

export const umbrellaSettings = (): UmbrellaSettings => ({ ...defaults(), ...readSetting<Partial<UmbrellaSettings>>(UMBRELLA_KEY, {}) });

export function parseKey(raw: string): ConnectionKey {
  const s = raw.trim();
  const fail = () => new HttpError(400, 'IDENTITY_KEY', 'This is not an Umbrella connection key: copy it again from Umbrella Monitoring');
  if (!s.startsWith('umbid1.')) throw fail();
  let k: ConnectionKey;
  try {
    k = JSON.parse(Buffer.from(s.slice(7), 'base64url').toString('utf8')) as ConnectionKey;
  } catch {
    throw fail();
  }
  if (!k?.hub || !k.client_id || !k.client_secret || !k.token) throw fail();
  try {
    const u = new URL(k.hub);
    if (!['http:', 'https:'].includes(u.protocol)) throw fail();
  } catch {
    throw fail();
  }
  return { ...k, hub: k.hub.replace(/\/+$/, '') };
}

async function storedKey(): Promise<ConnectionKey | null> {
  const s = umbrellaSettings();
  const secret = await getSecret(SECRET, 'client_secret');
  const token = await getSecret(SECRET, 'token');
  return s.hub && secret && token ? { hub: s.hub, client_id: s.client_id, client_secret: secret, token } : null;
}

/** GET a federation document with an ETag; null when not modified. */
async function federation<T>(k: ConnectionKey, path: string, etag?: string): Promise<{ data: T; etag: string } | null> {
  const res = await fetch(`${k.hub}${path}`, {
    headers: { authorization: `Bearer ${k.token}`, accept: 'application/json', ...(etag ? { 'if-none-match': etag } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 304) return null;
  if (res.status === 401) throw new Error('Umbrella refused the synchronization token: issue a new connection key');
  if (!res.ok) throw new Error(`Umbrella answered HTTP ${res.status}`);
  return { data: (await res.json()) as T, etag: res.headers.get('etag') ?? '' };
}

interface HubConfig {
  application: { id: string; name: string; sync_passkeys: boolean };
  password_policy: PasswordPolicy;
  passkeys: { enabled: boolean; rp_id: string };
  methods: { id: string; title: string }[];
}

interface HubUser {
  id: string;
  username: string;
  email: string;
  name: string;
  disabled: boolean;
  role: { id: string; name: string } | null;
  admin: boolean;
  groups: string[];
  passkeys: { id: string; name: string; credential_id: string; public_key: string; user_handle: string; sign_count: number; aaguid: string; transports: string[]; backup_eligible: boolean; created_at: string }[];
}

const client = (k: ConnectionKey, base: string): Client => ({
  issuer: k.hub,
  clientId: k.client_id,
  secret: k.client_secret,
  redirectUri: `${base}${UMBRELLA_CALLBACK}`,
  scopes: ['openid', 'profile', 'email', 'groups'],
});

/** Step 1 of the connection: what the hub says about a key. */
export async function checkKey(k: ConnectionKey, base: string) {
  if (!base) throw new HttpError(400, 'PUBLIC_URL_REQUIRED', 'Set the address of Inventory DB first');
  let cfg, users;
  try {
    cfg = (await federation<HubConfig>(k, '/api/identity/v1/config'))!.data;
    users = (await federation<{ users: HubUser[] }>(k, '/api/identity/v1/users'))!.data.users;
    // A token request with a made-up code is refused as invalid_grant for a known client, invalid_client otherwise.
    await exchange(client(k, base), `check-${Date.now()}`, newRequest()).catch((e: Error) => {
      if (/invalid_client/.test(e.message)) throw new Error('Umbrella refused the client secret: issue a new connection key');
      if (!/invalid_grant/.test(e.message)) throw e;
    });
  } catch (e) {
    throw new HttpError(400, 'IDENTITY_UNAVAILABLE', (e as Error).message);
  }
  const host = new URL(base).hostname;
  const active = users.filter((u) => !u.disabled);
  const db = getDb();
  return {
    hub: k.hub,
    application: cfg.application.name,
    methods: cfg.methods,
    passkeys: cfg.passkeys,
    passkeys_here: cfg.passkeys.enabled && !!cfg.passkeys.rp_id && hostWithin(host, cfg.passkeys.rp_id),
    users: active.length,
    roles: [...new Set(active.map((u) => u.role?.name).filter((x): x is string => !!x))].sort(),
    groups: [...new Set(active.flatMap((u) => u.groups ?? []))].sort().slice(0, 500),
    conflicts: active
      .filter((u) => u.email && (db.prepare("SELECT 1 FROM nc_users WHERE lower(email) = lower(?) AND source <> 'umbrella'").get(u.email) as unknown))
      .map((u) => u.email),
  };
}

export function mapRole(s: UmbrellaSettings, role: string | undefined, groups: string[], admin: boolean): MappedRole {
  for (const m of s.role_map) {
    const x = m.match.trim().toLowerCase();
    if (x && (x === (role ?? '').toLowerCase() || groups.some((g) => g.toLowerCase() === x))) return m.role;
  }
  return admin ? s.admin_role : s.default_role;
}

export async function connect(input: Partial<UmbrellaSettings> & { key?: string }, base: string, userId: string) {
  const old = umbrellaSettings();
  const k = input.key?.trim() ? parseKey(input.key) : await storedKey();
  if (!k) throw new HttpError(400, 'IDENTITY_KEY', 'Paste the connection key');
  const check = await checkKey(k, base);
  const s: UmbrellaSettings = {
    ...old,
    enabled: !!input.enabled,
    hub: k.hub,
    client_id: k.client_id,
    application: check.application,
    role_map: (input.role_map ?? []).filter((m) => m.match?.trim()).map((m) => ({ match: m.match.trim(), role: m.role })),
    admin_role: input.admin_role ?? old.admin_role,
    default_role: input.default_role ?? old.default_role,
    link_local: input.link_local ?? old.link_local,
    sso: input.sso ?? old.sso,
    sync_users: input.sync_users ?? old.sync_users,
    sync_policy: input.sync_policy ?? old.sync_policy,
    sync_passkeys: input.sync_passkeys ?? old.sync_passkeys,
    methods: check.methods,
    hub_passkeys: check.passkeys,
  };
  if (input.key?.trim()) {
    await setSecret(SECRET, { client_secret: k.client_secret, token: k.token });
    s.status = { ...s.status, config_etag: undefined, users_etag: undefined };
  }
  writeSetting(UMBRELLA_KEY, s, userId);
  logEvent('warn', 'Umbrella Identity connection changed', { hub: s.hub, enabled: s.enabled });
  if (s.enabled) await syncUmbrella('settings').catch(() => undefined);
  return umbrellaSettings();
}

export async function disconnect(userId: string) {
  const s = umbrellaSettings();
  writeSetting(UMBRELLA_KEY, { ...s, enabled: false }, userId);
  await deleteSecret(SECRET);
  getDb().prepare("UPDATE nc_users SET disabled = 1 WHERE source = 'umbrella'").run();
  logEvent('warn', 'Umbrella Identity disconnected', { hub: s.hub });
  return umbrellaSettings();
}

let running: Promise<void> | null = null;

/** Reads the hub's configuration and users and applies them. */
export async function syncUmbrella(actor: string): Promise<void> {
  if (running) return running;
  running = (async () => {
    const s = umbrellaSettings();
    if (!s.enabled) return;
    const k = await storedKey();
    const status = { ...s.status, conflicts: [] as string[] };
    try {
      if (!k) throw new Error('The connection key is not stored');
      const cfg = await federation<HubConfig>(k, '/api/identity/v1/config', s.status.config_etag);
      if (cfg) {
        status.config_etag = cfg.etag;
        s.methods = cfg.data.methods;
        s.hub_passkeys = cfg.data.passkeys;
        s.application = cfg.data.application.name;
        if (s.sync_policy) writeSetting('password_policy', normalizePolicy(cfg.data.password_policy), null);
      }
      if (s.sync_users) {
        const users = await federation<{ users: HubUser[] }>(k, '/api/identity/v1/users', s.status.users_etag);
        if (users) {
          status.users_etag = users.etag;
          Object.assign(status, { users: 0, created: 0, updated: 0, disabled: 0 });
          const keep: string[] = [];
          for (const hu of users.data.users) {
            const role = mapRole(s, hu.role?.name, hu.groups ?? [], hu.admin);
            if (hu.disabled || role === 'none' || !hu.email) continue;
            try {
              const r = upsertAccount(
                { source: 'umbrella', externalId: hu.id, email: hu.email, name: hu.name, username: hu.username, role },
                s.link_local ? ['local', 'ldap', 'entra'] : [],
              );
              keep.push(hu.id);
              status.users++;
              if (r.created) status.created++;
              else status.updated++;
              if (s.sync_passkeys && s.hub_passkeys.enabled) replaceHubPasskeys(r.user.id, hu.passkeys ?? []);
            } catch (e) {
              if (e instanceof HttpError && e.code === 'ACCOUNT_EXISTS') status.conflicts.push(hu.email);
              else throw e;
            }
          }
          status.disabled = disableMissing('umbrella', keep);
        }
      }
      status.ok = true;
      status.error = undefined;
    } catch (e) {
      status.ok = false;
      status.error = (e as Error).message;
      logEvent('error', 'Umbrella Identity synchronization failed', { error: status.error });
    }
    status.last_sync = new Date().toISOString();
    writeSetting(UMBRELLA_KEY, { ...s, status }, null);
    if (actor !== 'schedule' || status.created || status.disabled || !status.ok)
      logEvent(status.ok ? 'warn' : 'error', 'Umbrella Identity synchronized', { by: actor, ok: status.ok, created: status.created, disabled: status.disabled });
  })().finally(() => {
    running = null;
  });
  return running;
}

let timer: NodeJS.Timeout | null = null;

/** Synchronizes every five minutes while the process runs. */
export function scheduleUmbrellaSync() {
  if (timer) return;
  timer = setInterval(() => void syncUmbrella('schedule'), SYNC_EVERY_MS);
  timer.unref();
}

export async function umbrellaStartUrl(base: string, hint: string, req: Request): Promise<string> {
  const s = umbrellaSettings();
  const k = await storedKey();
  if (!s.enabled || !s.sso || !k || !base) throw new HttpError(409, 'UMBRELLA_OFF', 'Sign-in with Umbrella is turned off');
  const c = client(k, base);
  if (hint && hint !== 'umbrella') c.extra = { idp_hint: hint };
  return authUrl(c, req);
}

/** Finishes single sign-in: the account bound to the hub's subject (created if the synchronization has not run yet). */
export async function completeUmbrella(base: string, code: string, req: Request): Promise<User> {
  const s = umbrellaSettings();
  const k = await storedKey();
  if (!s.enabled || !k) throw new HttpError(409, 'UMBRELLA_OFF', 'Sign-in with Umbrella is turned off');
  const c = client(k, base);
  const t = await exchange(c, code, req);
  const cl = await verify(c, t.id_token, req.nonce);
  const bound = accountByExternal('umbrella', String(cl.sub));
  if (bound) {
    if (bound.disabled) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
    return bound;
  }
  const role = mapRole(s, (cl.umbrella_role as { name?: string } | undefined)?.name, strings(cl.groups), cl.umbrella_admin === true);
  if (role === 'none') throw new HttpError(403, 'UMBRELLA_NO_ACCESS', 'Your Umbrella account has no access to Inventory DB');
  const email = String(cl.email ?? '');
  if (!email) throw new HttpError(403, 'UMBRELLA_ACCOUNT', 'The Umbrella account has no e-mail address');
  return upsertAccount(
    { source: 'umbrella', externalId: String(cl.sub), email, name: String(cl.name ?? email), username: String(cl.preferred_username ?? ''), role },
    s.link_local ? ['local', 'ldap', 'entra'] : [],
  ).user;
}
