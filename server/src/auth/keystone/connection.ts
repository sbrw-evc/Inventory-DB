/**
 * The connection to Keystone (docs/keystone.md, Keystone's protocol.md): the connection key `spa1.<base64url(JSON)>` comes from the
 * deployment — `SPA_CONNECTION_KEY`, the file named by `SPA_CONNECTION_KEY_FILE`, or the secret store (OpenBao) at
 * `spa`, key `connection_key`. Without it nobody can sign in.
 */
import { readFileSync } from 'node:fs';
import type { FastifyRequest } from 'fastify';
import { getSecret } from '../../system/secrets.js';
import type { Client } from './oidc.js';

export const SPA_CALLBACK = '/api/auth/spa/callback';
export const SPA_SECRET_PATH = 'spa';
export const SPA_SECRET_KEY = 'connection_key';
const PREFIX = 'spa1.';

export interface ConnectionKey {
  issuer: string;
  client_id: string;
  client_secret: string;
  token: string;
}

export type KeySource = 'environment' | 'file' | 'secret_store';

export class SpaKeyError extends Error {}

export function parseKey(raw: string): ConnectionKey {
  const s = raw.trim();
  const fail = () => new SpaKeyError('This is not a Keystone connection key (spa1.…): copy it again from Keystone → Applications');
  if (!s.startsWith(PREFIX)) throw fail();
  let k: ConnectionKey;
  try {
    k = JSON.parse(Buffer.from(s.slice(PREFIX.length), 'base64url').toString('utf8')) as ConnectionKey;
  } catch {
    throw fail();
  }
  if (!k || typeof k !== 'object' || !k.issuer || !k.client_id || !k.client_secret || !k.token) throw fail();
  let u: URL;
  try {
    u = new URL(k.issuer);
  } catch {
    throw fail();
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw fail();
  return { issuer: k.issuer.replace(/\/+$/, ''), client_id: String(k.client_id), client_secret: String(k.client_secret), token: String(k.token) };
}

export interface LoadedKey {
  key: ConnectionKey | null;
  source: KeySource | null;
  /** Why a configured key could not be used. */
  error?: string;
}

/** The connection key from the environment, its file, or the secret store (in that order). */
export async function loadKey(): Promise<LoadedKey> {
  let raw: string | null = null;
  let source: KeySource | null = null;
  try {
    if (process.env.SPA_CONNECTION_KEY?.trim()) {
      raw = process.env.SPA_CONNECTION_KEY;
      source = 'environment';
    } else if (process.env.SPA_CONNECTION_KEY_FILE?.trim()) {
      source = 'file';
      raw = readFileSync(process.env.SPA_CONNECTION_KEY_FILE.trim(), 'utf8');
    } else {
      const stored = await getSecret(SPA_SECRET_PATH, SPA_SECRET_KEY).catch(() => null);
      if (stored?.trim()) {
        raw = stored;
        source = 'secret_store';
      }
    }
    if (!raw) return { key: null, source };
    return { key: parseKey(raw), source };
  } catch (e) {
    return { key: null, source, error: (e as Error).message };
  }
}

/** The address of Ledger: SPA_PUBLIC_URL, else the address of the request. */
export function publicBase(req: FastifyRequest): string {
  const set = process.env.SPA_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (set) return set;
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

export const oidcClient = (k: ConnectionKey, base: string, extra?: Record<string, string>): Client => ({
  issuer: k.issuer,
  clientId: k.client_id,
  secret: k.client_secret,
  redirectUri: `${base}${SPA_CALLBACK}`,
  scopes: ['openid', 'profile', 'email', 'groups', 'roles'],
  extra,
});
