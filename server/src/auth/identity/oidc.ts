/**
 * OpenID Connect relying party for Google (Workspace), Sign in with Apple, any OpenID Connect provider and the
 * Umbrella Identity hub: discovery, authorization code flow with PKCE, ID token verification (keys from the
 * provider's JWKS) and the client secret of Apple (an ES256 JWT signed with the team's key).
 */
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify, type JWTPayload } from 'jose';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const APPLE_ISSUER = 'https://appleid.apple.com';
const TIMEOUT_MS = 10_000;

export interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

const discovered = new Map<string, { m: Metadata; at: number }>();
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function clearOidcCaches() {
  discovered.clear();
  keySets.clear();
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', ...(init?.headers ?? {}) } });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; error_description?: string };
    throw new Error(`${url}: HTTP ${res.status} ${d.error ?? ''} ${d.error_description ?? ''}`.trim());
  }
  return data as T;
}

export async function discover(issuer: string): Promise<Metadata> {
  const iss = issuer.replace(/\/+$/, '');
  const hit = discovered.get(iss);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.m;
  const m = await getJson<Metadata>(`${iss}/.well-known/openid-configuration`);
  if ((m.issuer ?? '').replace(/\/+$/, '') !== iss) throw new Error(`The discovery document of ${iss} names the issuer ${m.issuer}`);
  if (!m.authorization_endpoint || !m.token_endpoint || !m.jwks_uri) throw new Error(`The discovery document of ${iss} lacks endpoints`);
  discovered.set(iss, { m, at: Date.now() });
  return m;
}

export interface Request {
  state: string;
  nonce: string;
  verifier: string;
}

export const random = () => randomBytes(32).toString('base64url');
export const newRequest = (): Request => ({ state: random(), nonce: random(), verifier: random() });
export const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export interface Client {
  issuer: string;
  clientId: string;
  secret: string;
  redirectUri: string;
  scopes: string[];
  extra?: Record<string, string>;
}

export async function authUrl(c: Client, r: Request): Promise<string> {
  const m = await discover(c.issuer);
  const q = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: c.redirectUri,
    scope: c.scopes.join(' '),
    state: r.state,
    nonce: r.nonce,
    code_challenge: challenge(r.verifier),
    code_challenge_method: 'S256',
    ...(c.extra ?? {}),
  });
  return `${m.authorization_endpoint}${m.authorization_endpoint.includes('?') ? '&' : '?'}${q}`;
}

export async function exchange(c: Client, code: string, r: Request): Promise<{ id_token: string; access_token?: string }> {
  const m = await discover(c.issuer);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: c.redirectUri,
    client_id: c.clientId,
    client_secret: c.secret,
    code_verifier: r.verifier,
  });
  const t = await getJson<{ id_token?: string; access_token?: string }>(m.token_endpoint, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (!t.id_token) throw new Error('The token endpoint returned no ID token');
  return { id_token: t.id_token, access_token: t.access_token };
}

export async function verify(c: Client, idToken: string, nonce: string): Promise<JWTPayload & Record<string, unknown>> {
  const m = await discover(c.issuer);
  let jwks = keySets.get(m.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(m.jwks_uri), { timeoutDuration: TIMEOUT_MS });
    keySets.set(m.jwks_uri, jwks);
  }
  const { payload } = await jwtVerify(idToken, jwks, { issuer: m.issuer, audience: c.clientId, algorithms: ['RS256', 'ES256'], clockTolerance: 60 });
  if (nonce && payload.nonce !== nonce) throw new Error('The ID token has a wrong nonce');
  return payload as JWTPayload & Record<string, unknown>;
}

/** The client secret of Sign in with Apple: a JWT signed with the team's .p8 key. */
export async function appleSecret(teamId: string, keyId: string, clientId: string, keyPem: string): Promise<string> {
  const key = await importPKCS8(keyPem.trim(), 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt()
    .setExpirationTime('10m')
    .setAudience(APPLE_ISSUER)
    .setSubject(clientId)
    .sign(key);
}

export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
