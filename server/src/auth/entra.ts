/**
 * Sign-in with Microsoft Entra ID (OpenID Connect authorization code flow with PKCE), as in Umbrella: the app is
 * registered in the tenant, users are let in when they belong to the users group (if one is set), and members of the
 * administrators group become DCIM/IPAM admins.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export type EntraCloud = 'global' | 'usgov' | 'china';
export const ENTRA_CLOUDS: EntraCloud[] = ['global', 'usgov', 'china'];
export const ENTRA_CALLBACK = '/api/v1/auth/entra/callback';

export interface EntraConfig {
  enabled: boolean;
  cloud: EntraCloud;
  tenant_id: string;
  client_id: string;
  redirect_url: string;
  admin_group_id: string;
  user_group_id: string;
}

export interface EntraProbe {
  issuer?: string;
  tenant_id?: string;
  credentials: boolean;
}

export interface EntraIdentity {
  oid: string;
  email: string;
  name: string;
  admin: boolean;
}

const LOGIN: Record<EntraCloud, string> = {
  global: 'https://login.microsoftonline.com',
  usgov: 'https://login.microsoftonline.us',
  china: 'https://login.chinacloudapi.cn',
};
const GRAPH: Record<EntraCloud, string> = {
  global: 'https://graph.microsoft.com',
  usgov: 'https://graph.microsoft.us',
  china: 'https://microsoftgraph.chinacloudapi.cn',
};
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 10_000;

export const defaultEntraConfig = (): EntraConfig => ({
  enabled: false,
  cloud: 'global',
  tenant_id: '',
  client_id: '',
  redirect_url: '',
  admin_group_id: '',
  user_group_id: '',
});

// ENTRA_AUTHORITY_URL / ENTRA_GRAPH_URL point the flow at a stand-in identity provider (tests).
const loginBase = (c: EntraConfig) => (process.env.ENTRA_AUTHORITY_URL || LOGIN[c.cloud]).replace(/\/+$/, '');
const graphBase = (c: EntraConfig) => (process.env.ENTRA_GRAPH_URL || GRAPH[c.cloud]).replace(/\/+$/, '');

export function normalizeEntra(c: EntraConfig): EntraConfig {
  const out: EntraConfig = {
    enabled: !!c.enabled,
    cloud: ENTRA_CLOUDS.includes(c.cloud) ? c.cloud : 'global',
    tenant_id: (c.tenant_id ?? '').trim(),
    client_id: (c.client_id ?? '').trim(),
    redirect_url: (c.redirect_url ?? '').trim(),
    admin_group_id: (c.admin_group_id ?? '').trim(),
    user_group_id: (c.user_group_id ?? '').trim(),
  };
  if (!out.enabled) return out;
  if (!out.tenant_id || !/^[A-Za-z0-9.-]+$/.test(out.tenant_id)) throw new Error('Directory (tenant) ID must be a GUID or a domain such as contoso.onmicrosoft.com');
  if (['common', 'organizations', 'consumers'].includes(out.tenant_id.toLowerCase())) throw new Error('Use the tenant of your organization, not a multi-tenant endpoint');
  if (!GUID.test(out.client_id)) throw new Error('Application (client) ID must be a GUID');
  for (const g of [out.admin_group_id, out.user_group_id]) if (g && !GUID.test(g)) throw new Error('Group IDs must be GUIDs (object IDs of the groups)');
  let url: URL;
  try {
    url = new URL(out.redirect_url);
  } catch {
    throw new Error(`The redirect URI must be an absolute URL ending in ${ENTRA_CALLBACK}`);
  }
  if (!/^https?:$/.test(url.protocol) || url.pathname !== ENTRA_CALLBACK || url.search) throw new Error(`The redirect URI must be an absolute URL ending in ${ENTRA_CALLBACK}`);
  return out;
}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body?.error_description || body?.error?.message || body?.error || `HTTP ${res.status}`;
    throw new Error(String(msg).split(/\r?\n/)[0]);
  }
  return body;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveries = new Map<string, { at: number; doc: Promise<Discovery> }>();

export function discovery(c: EntraConfig): Promise<Discovery> {
  const url = `${loginBase(c)}/${encodeURIComponent(c.tenant_id)}/v2.0/.well-known/openid-configuration`;
  const hit = discoveries.get(url);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.doc;
  const doc = getJson(url).catch((e) => {
    discoveries.delete(url);
    throw new Error(`Tenant ${c.tenant_id}: ${(e as Error).message}`);
  }) as Promise<Discovery>;
  discoveries.set(url, { at: Date.now(), doc });
  return doc;
}

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function keySet(uri: string) {
  let set = jwks.get(uri);
  if (!set) jwks.set(uri, (set = createRemoteJWKSet(new URL(uri))));
  return set;
}

/** Tests. */
export function clearEntraCaches() {
  discoveries.clear();
  jwks.clear();
}

/** Settings page check: the tenant answers and the client secret works (client credentials grant). */
export async function entraTest(c: EntraConfig, clientSecret: string): Promise<EntraProbe> {
  const d = await discovery(c);
  const tenant = /\/([0-9a-f-]{36})\//i.exec(d.issuer)?.[1];
  const probe: EntraProbe = { issuer: d.issuer, tenant_id: tenant, credentials: false };
  try {
    await getJson(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.client_id, client_secret: clientSecret, scope: `${graphBase(c)}/.default` }),
    });
  } catch (e) {
    throw new Error(`Client secret: ${(e as Error).message}`);
  }
  probe.credentials = true;
  return probe;
}

export async function entraPing(c: EntraConfig): Promise<string> {
  return (await discovery(c)).issuer;
}

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

export async function authorizeUrl(c: EntraConfig, opts: { state: string; nonce: string; challenge: string }): Promise<string> {
  const d = await discovery(c);
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: c.client_id,
    response_type: 'code',
    redirect_uri: c.redirect_url,
    response_mode: 'query',
    scope: 'openid profile email User.Read',
    state: opts.state,
    nonce: opts.nonce,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

/** Exchanges the code, verifies the ID token and works out the user's groups. */
export async function completeSignIn(c: EntraConfig, clientSecret: string, code: string, verifier: string, nonce: string): Promise<EntraIdentity> {
  const d = await discovery(c);
  const tokens = await getJson(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: c.client_id,
      client_secret: clientSecret,
      code,
      redirect_uri: c.redirect_url,
      code_verifier: verifier,
    }),
  });
  if (!tokens?.id_token) throw new Error('Entra ID returned no ID token');
  const { payload } = await jwtVerify(tokens.id_token as string, keySet(d.jwks_uri), { issuer: d.issuer, audience: c.client_id });
  if (payload.nonce !== nonce) throw new Error('The sign-in response does not match this browser session');
  const oid = String(payload.oid ?? payload.sub ?? '');
  if (!oid) throw new Error('The ID token has no user object ID');
  const groups = await groupsOf(c, payload, tokens.access_token as string | undefined);
  if (c.user_group_id && !groups?.includes(c.user_group_id.toLowerCase())) throw new Error('Your account is not in the group allowed to sign in to Inventory DB');
  const email = String(payload.email ?? payload.preferred_username ?? payload.upn ?? '').toLowerCase();
  if (!email) throw new Error('The ID token has no email or user name');
  return {
    oid,
    email,
    name: String(payload.name ?? email.split('@')[0]),
    admin: !!c.admin_group_id && !!groups?.includes(c.admin_group_id.toLowerCase()),
  };
}

/** Group object IDs from the token, or from Microsoft Graph when the user has too many groups for the token. */
async function groupsOf(c: EntraConfig, claims: JWTPayload, accessToken?: string): Promise<string[] | null> {
  if (!c.admin_group_id && !c.user_group_id) return [];
  if (Array.isArray(claims.groups)) return (claims.groups as string[]).map((g) => g.toLowerCase());
  const overage = (claims as { _claim_names?: { groups?: string } })._claim_names?.groups;
  if (!overage && !accessToken) return [];
  if (!accessToken) return null;
  try {
    const res = await getJson(`${graphBase(c)}/v1.0/me/getMemberGroups`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ securityEnabledOnly: false }),
    });
    return ((res?.value ?? []) as string[]).map((g) => g.toLowerCase());
  } catch {
    return null;
  }
}
