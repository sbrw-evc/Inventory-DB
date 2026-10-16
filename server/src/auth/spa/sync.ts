/**
 * SPA's federation API (`/api/spa/v1/{config,users,roles}`): every five minutes (one replica only) Inventory DB reads
 * the people who may use it and their roles and creates, updates and disables its user records; it publishes its
 * DCIM/IPAM role catalogue at start. The state shown on the settings page lives in the setting `spa.state`.
 */
import { getDb } from '../../db/index.js';
import { logEvent } from '../../system/logbuf.js';
import { readSetting, writeSetting } from '../../system/settings.js';
import { loadKey, type ConnectionKey } from './connection.js';
import { DEFAULT_ROLE, ROLE_CATALOGUE, disableOthers, roleFrom, upsertSpaUser } from './users.js';

const STATE_KEY = 'spa.state';
const SYNC_EVERY_MS = 5 * 60_000;
const TIMEOUT_MS = 20_000;

export interface SpaConfig {
  application: { id: string; name: string; type: string };
  roles: { id: string; name: string; description?: string }[];
  methods: { id: string; title: string }[];
  sign_out_url: string;
  account_url: string;
}

export interface SpaUser {
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

export interface SpaState {
  /** The issuer and client the state below belongs to; a new key starts afresh. */
  issuer?: string;
  client_id?: string;
  config?: SpaConfig;
  config_etag?: string;
  users_etag?: string;
  roles_published_at?: string;
  roles_error?: string;
  last_sync?: string;
  last_success?: string;
  ok: boolean;
  error?: string;
  counts: { users: number; created: number; updated: number; matched: number; disabled: number };
}

const empty = (): SpaState => ({ ok: false, counts: { users: 0, created: 0, updated: 0, matched: 0, disabled: 0 } });

/** The stored state, or a fresh one when it belongs to another key. */
export function spaState(k?: ConnectionKey | null): SpaState {
  const s = { ...empty(), ...readSetting<Partial<SpaState>>(STATE_KEY, {}) };
  if (k && (s.issuer !== k.issuer || s.client_id !== k.client_id)) return { ...empty(), issuer: k.issuer, client_id: k.client_id };
  return s;
}

const saveState = (s: SpaState) => writeSetting(STATE_KEY, s, null);

export class SpaUnauthorized extends Error {}

async function call<T>(k: ConnectionKey, method: 'GET' | 'PUT', path: string, opts: { etag?: string; body?: unknown } = {}): Promise<{ data: T; etag: string } | null> {
  const res = await fetch(`${k.issuer}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${k.token}`,
      accept: 'application/json',
      ...(opts.etag ? { 'if-none-match': opts.etag } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 304) return null;
  if (res.status === 401) throw new SpaUnauthorized('SPA refused the connection key (it was replaced or the application was removed): issue a new key in SPA');
  if (!res.ok) throw new Error(`SPA answered HTTP ${res.status} to ${method} ${path}`);
  const text = await res.text();
  return { data: (text ? JSON.parse(text) : {}) as T, etag: res.headers.get('etag') ?? '' };
}

/** `GET /api/spa/v1/config`, kept in the state (with its ETag). */
export async function fetchConfig(k: ConnectionKey, s: SpaState): Promise<SpaConfig | undefined> {
  const r = await call<SpaConfig>(k, 'GET', '/api/spa/v1/config', { etag: s.config ? s.config_etag : undefined });
  if (r) {
    s.config = r.data;
    s.config_etag = r.etag || undefined;
  }
  return s.config;
}

/** `PUT /api/spa/v1/roles`: the DCIM/IPAM role catalogue. */
export async function publishRoles(k: ConnectionKey, s: SpaState) {
  try {
    await call(k, 'PUT', '/api/spa/v1/roles', { body: { roles: ROLE_CATALOGUE, default: DEFAULT_ROLE } });
    s.roles_published_at = new Date().toISOString();
    s.roles_error = undefined;
  } catch (e) {
    s.roles_error = (e as Error).message;
    logEvent('error', 'The role catalogue could not be published to SPA', { error: s.roles_error });
  }
}

let published = '';
let running: Promise<SpaState> | null = null;

/**
 * Reads SPA's configuration and users and applies them: creates and updates records, sets roles, and disables (ending
 * the sessions and suspending the API tokens of) everyone SPA does not list as enabled with a role here; people
 * enabled again get their suspended tokens back.
 */
export function syncSpa(actor: string, opts: { force?: boolean } = {}): Promise<SpaState> {
  if (running) return running;
  running = (async () => {
    const { key: k, error: keyError } = await loadKey();
    const s = spaState(k);
    if (!k) {
      s.ok = false;
      s.error = keyError ?? 'Inventory DB is not connected to SPA';
      return s;
    }
    s.last_sync = new Date().toISOString();
    try {
      // The catalogue once per process and key (and again when asked), so SPA administrators assign our roles.
      const pubKey = `${k.issuer} ${k.client_id}`;
      if (published !== pubKey || opts.force) {
        await publishRoles(k, s);
        if (!s.roles_error) published = pubKey;
      }
      await fetchConfig(k, s);
      const r = await call<{ users: SpaUser[] }>(k, 'GET', '/api/spa/v1/users', { etag: opts.force ? undefined : s.users_etag });
      if (r) {
        const counts = { users: 0, created: 0, updated: 0, matched: 0, disabled: 0 };
        const keep: string[] = [];
        for (const u of r.data.users ?? []) {
          if (!u?.id) continue;
          const role = roleFrom(u.roles ?? []);
          const res = upsertSpaUser({ sub: String(u.id), username: u.username ?? '', email: u.email ?? '', name: u.name ?? '', role, disabled: !!u.disabled });
          if (res.created) counts.created++;
          else counts.updated++;
          if (res.matched) counts.matched++;
          if (res.turnedOff) counts.disabled++;
          if (!res.disabled) {
            keep.push(String(u.id));
            counts.users++;
          }
        }
        // Gone from SPA, disabled there, and records from before SPA that matched nobody.
        counts.disabled += disableOthers(keep);
        s.counts = counts;
        s.users_etag = r.etag || undefined;
      }
      s.ok = true;
      s.error = undefined;
      s.last_success = s.last_sync;
    } catch (e) {
      s.ok = false;
      s.error = (e as Error).message;
      logEvent('error', 'SPA synchronization failed', { by: actor, error: s.error });
    }
    saveState(s);
    if (actor !== 'schedule' || !s.ok || s.counts.created || s.counts.disabled)
      logEvent(s.ok ? 'warn' : 'error', 'Users synchronized from SPA', { by: actor, ok: s.ok, ...s.counts });
    return s;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Only one replica synchronizes: the one holding the advisory lock of this database schema. */
function isLeader(): boolean {
  try {
    const r = getDb().prepare('SELECT pg_try_advisory_lock(724115, hashtext(current_schema())) AS ok').get() as { ok: boolean };
    return !!r?.ok;
  } catch {
    return false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Publishes the catalogue and synchronizes at start, then every five minutes while the process runs. */
export function scheduleSpaSync() {
  if (timer) return;
  const tick = () => {
    if (isLeader()) void syncSpa('schedule').catch(() => undefined);
  };
  setTimeout(tick, 1000).unref();
  timer = setInterval(tick, SYNC_EVERY_MS);
  timer.unref();
}

export function stopSpaSync() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Forget what was published (tests: a new key or a new fake SPA). */
export function resetSpaSyncMemory() {
  published = '';
}
