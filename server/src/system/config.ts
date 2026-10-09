/**
 * Bootstrap settings that cannot live in the database itself: where the database is and how to reach OpenBao.
 * Stored in `<CONFIG_DIR>/inventory.json` (mode 0600) once an administrator moves the database or OpenBao from the
 * settings pages; until then they come from the environment (`DATABASE_URL`, `OPENBAO_*`).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type OpenBaoAuth = 'token' | 'approle';

export interface OpenBaoConnection {
  addr: string;
  mount: string;
  namespace?: string;
  auth: OpenBaoAuth;
  token?: string;
  token_file?: string;
  role_id?: string;
  role_id_file?: string;
  secret_id?: string;
  secret_id_file?: string;
  approle_path?: string;
  ca_cert?: string;
  skip_verify?: boolean;
}

export interface PostgresConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  sslmode: PgSslMode;
}

/** disable: plain TCP; require: encrypted, certificate not checked; verify-full: encrypted and verified. */
export type PgSslMode = 'disable' | 'require' | 'verify-full';
export const PG_SSL_MODES: PgSslMode[] = ['disable', 'require', 'verify-full'];

export interface ConfigFile {
  version: 1;
  openbao?: OpenBaoConnection;
  postgres?: PostgresConnection & {
    /** Where the password is: in OpenBao (`system/postgres`) or, without OpenBao, in this file. */
    password_in: 'openbao' | 'file';
    password?: string;
  };
  updated_at?: string;
}

export const DEFAULT_MOUNT = 'inventory';

export function configDir() {
  return resolve(process.env.CONFIG_DIR ?? 'data/config');
}

const filePath = () => join(configDir(), 'inventory.json');

export function readConfig(): ConfigFile {
  const path = filePath();
  if (!existsSync(path)) return { version: 1 };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ConfigFile;
  if (parsed.version !== 1) throw new Error(`${path}: unsupported version ${String(parsed.version)}`);
  return parsed;
}

export function writeConfig(patch: Partial<Omit<ConfigFile, 'version'>>) {
  const next: ConfigFile = { ...readConfig(), ...patch, version: 1, updated_at: new Date().toISOString() };
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not supported on this file system */
  }
}

/** OpenBao connection: the config file wins over the environment. Null when OpenBao is not configured. */
export function openBaoFromEnv(env: NodeJS.ProcessEnv = process.env): OpenBaoConnection | null {
  const addr = env.OPENBAO_ADDR?.trim();
  if (!addr) return null;
  const approle = !!(env.OPENBAO_ROLE_ID || env.OPENBAO_ROLE_ID_FILE);
  return {
    addr,
    mount: env.OPENBAO_MOUNT?.trim() || DEFAULT_MOUNT,
    namespace: env.OPENBAO_NAMESPACE?.trim() || undefined,
    auth: approle ? 'approle' : 'token',
    token: env.OPENBAO_TOKEN || undefined,
    token_file: env.OPENBAO_TOKEN_FILE || undefined,
    role_id: env.OPENBAO_ROLE_ID || undefined,
    role_id_file: env.OPENBAO_ROLE_ID_FILE || undefined,
    secret_id: env.OPENBAO_SECRET_ID || undefined,
    secret_id_file: env.OPENBAO_SECRET_ID_FILE || undefined,
    approle_path: env.OPENBAO_APPROLE_PATH || undefined,
    ca_cert: env.OPENBAO_CACERT_PEM || (env.OPENBAO_CACERT ? readFileSync(env.OPENBAO_CACERT, 'utf8') : undefined),
    skip_verify: env.OPENBAO_SKIP_VERIFY === '1' || env.OPENBAO_SKIP_VERIFY === 'true',
  };
}

export function configuredOpenBao(): OpenBaoConnection | null {
  return readConfig().openbao ?? openBaoFromEnv();
}

/** postgres://user:password@host:port/db?sslmode=... */
export function postgresUrl(c: PostgresConnection, password: string): string {
  const auth = `${encodeURIComponent(c.user)}${password ? ':' + encodeURIComponent(password) : ''}`;
  const host = c.host.includes(':') && !c.host.startsWith('[') ? `[${c.host}]` : c.host;
  const query = c.sslmode === 'verify-full' ? '?sslmode=verify-full' : c.sslmode === 'require' ? '?sslmode=no-verify' : '';
  return `postgres://${auth}@${host}:${c.port}/${encodeURIComponent(c.database)}${query}`;
}

/** Splits a connection URL into its parts (the password separately). */
export function parsePostgresUrl(url: string): { connection: PostgresConnection; password: string } {
  const u = new URL(url);
  const mode = u.searchParams.get('sslmode');
  const sslmode: PgSslMode =
    mode === 'verify-full' || mode === 'verify-ca' ? 'verify-full' : mode === 'require' || mode === 'no-verify' || mode === 'prefer' ? 'require' : 'disable';
  return {
    connection: {
      host: u.hostname.replace(/^\[|\]$/g, '') || 'localhost',
      port: Number(u.port || 5432),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username),
      user: decodeURIComponent(u.username),
      sslmode,
    },
    password: decodeURIComponent(u.password),
  };
}
