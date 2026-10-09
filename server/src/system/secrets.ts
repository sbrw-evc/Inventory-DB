/**
 * Every secret Inventory DB keeps (integration signing secrets, the LDAP bind password, the Entra ID client secret,
 * the PostgreSQL password, the session signing key) goes through this store. With OpenBao configured the secrets
 * live in its KV v2 mount; without it they are kept encrypted (AES-256-GCM) in the `nc_secrets` table, and the
 * settings pages say so. Paths are logical, e.g. `integrations/int_abc` or `directory/ldap`.
 */
import { getDb, now } from '../db/index.js';
import { decryptSecret, encryptSecret } from '../integrations/secrets.js';
import type { OpenBaoConnection } from './config.js';
import { logEvent } from './logbuf.js';
import { OpenBaoClient } from './openbao.js';

export type SecretBackendKind = 'openbao' | 'local';
type Data = Record<string, string>;

interface Backend {
  kind: SecretBackendKind;
  read(path: string): Promise<Data | null>;
  write(path: string, data: Data): Promise<void>;
  remove(path: string): Promise<void>;
  list(): Promise<string[]>;
}

const local: Backend = {
  kind: 'local',
  async read(path) {
    const row = getDb().prepare('SELECT data_enc FROM nc_secrets WHERE path = ?').get(path) as { data_enc: string } | undefined;
    return row ? (JSON.parse(decryptSecret(row.data_enc)) as Data) : null;
  },
  async write(path, data) {
    getDb()
      .prepare('INSERT INTO nc_secrets (path, data_enc, updated_at) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET data_enc = excluded.data_enc, updated_at = excluded.updated_at')
      .run(path, encryptSecret(JSON.stringify(data)), now());
  },
  async remove(path) {
    getDb().prepare('DELETE FROM nc_secrets WHERE path = ?').run(path);
  },
  async list() {
    return (getDb().prepare('SELECT path FROM nc_secrets ORDER BY path').all() as { path: string }[]).map((r) => r.path);
  },
};

const baoBackend = (client: OpenBaoClient): Backend => ({
  kind: 'openbao',
  read: (path) => client.read(path),
  write: (path, data) => client.write(path, data),
  remove: (path) => client.remove(path),
  // Throw-away secrets of connection checks are not the app's.
  list: async () => (await client.list()).filter((p) => !p.startsWith('_check/')),
});

let backend: Backend = local;
let client: OpenBaoClient | null = null;
const CACHE_MS = 30_000;
const cache = new Map<string, { data: Data | null; at: number }>();

export const secretBackend = (): SecretBackendKind => backend.kind;
export const openBaoClient = (): OpenBaoClient | null => client;

/** Connects to OpenBao (waiting up to `waitMs` for it to come up) and makes it the secret store. */
export async function useOpenBao(conn: OpenBaoConnection, waitMs = 0): Promise<OpenBaoClient> {
  const next = new OpenBaoClient(conn);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await next.login();
      break;
    } catch (e) {
      if (Date.now() >= deadline) {
        next.close();
        throw e;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  client?.close();
  client = next;
  backend = baoBackend(next);
  cache.clear();
  return next;
}

/** Back to the encrypted table (tests, or no OpenBao configured). */
export function useLocalSecrets() {
  client?.close();
  client = null;
  backend = local;
  cache.clear();
}

async function readData(path: string): Promise<Data | null> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await backend.read(path);
  cache.set(path, { data, at: Date.now() });
  return data;
}

export async function getSecret(path: string, key: string): Promise<string | null> {
  return (await readData(path))?.[key] ?? null;
}

/** Merges `values` into the secret at `path`; an empty or null value removes that key, and an empty secret is deleted. */
export async function setSecret(path: string, values: Record<string, string | null | undefined>): Promise<void> {
  cache.delete(path);
  const merged: Data = { ...((await backend.read(path)) ?? {}) };
  for (const [k, v] of Object.entries(values)) {
    if (v) merged[k] = v;
    else delete merged[k];
  }
  if (Object.keys(merged).length) await backend.write(path, merged);
  else await backend.remove(path);
  cache.set(path, { data: Object.keys(merged).length ? merged : null, at: Date.now() });
}

export async function deleteSecret(path: string): Promise<void> {
  cache.delete(path);
  await backend.remove(path);
}

/** Paths and key names (never values) of every stored secret. */
export async function listSecrets(): Promise<{ path: string; keys: string[] }[]> {
  const paths = await backend.list();
  const out: { path: string; keys: string[] }[] = [];
  for (const path of paths) out.push({ path, keys: Object.keys((await readData(path)) ?? {}).sort() });
  return out;
}

/** Number of secrets still in the local table (left over from before OpenBao was configured). */
export function localSecretCount(): number {
  return (getDb().prepare('SELECT COUNT(*) n FROM nc_secrets').get() as { n: number }).n;
}

/** Moves secrets kept in the local table into OpenBao, then deletes the local copies. */
export async function moveLocalSecretsToOpenBao(): Promise<number> {
  if (backend.kind !== 'openbao') return 0;
  const paths = await local.list();
  for (const path of paths) {
    const data = await local.read(path);
    if (data) {
      const existing = (await backend.read(path)) ?? {};
      await backend.write(path, { ...data, ...existing });
    }
    await local.remove(path);
  }
  if (paths.length) logEvent('warn', 'Moved secrets from the database into OpenBao', { count: paths.length });
  cache.clear();
  return paths.length;
}

/** Copies every secret of the current store into `target` (another OpenBao). Returns the copied paths. */
export async function copySecretsTo(target: OpenBaoClient): Promise<string[]> {
  const paths = await backend.list();
  for (const path of paths) {
    const data = await backend.read(path);
    if (data) await target.write(path, data);
  }
  return paths;
}
