/**
 * Sign-in with Google (Workspace), Apple and any OpenID Connect provider, as in Umbrella Monitoring. Settings key
 * `identity.providers`; secrets in the secret store at `identity/providers/<kind>`. A person is bound to the
 * provider's subject; an account with the same verified e-mail of an allowed domain is signed in; otherwise an
 * account is created with the provider's role unless only existing accounts may sign in.
 */
import type { User } from '../../../../shared/src/index.js';
import { HttpError, badRequest } from '../../errors.js';
import type { NetboxRole } from '../../netbox/access.js';
import { logEvent } from '../../system/logbuf.js';
import { getSecret, setSecret } from '../../system/secrets.js';
import { readSetting, writeSetting } from '../../system/settings.js';
import { accountByEmail, accountByExternal, upsertAccount } from './accounts.js';
import { APPLE_ISSUER, GOOGLE_ISSUER, appleSecret, discover, exchange, verify, strings, type Client, type Request } from './oidc.js';

export const PROVIDER_KINDS = ['google', 'apple', 'oidc'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export const PROVIDERS_KEY = 'identity.providers';
const secretPath = (kind: ProviderKind) => `identity/providers/${kind}`;

export interface Provider {
  enabled: boolean;
  title: string;
  issuer: string;
  client_id: string;
  team_id: string;
  key_id: string;
  allowed_domains: string[];
  existing_only: boolean;
  scopes: string;
  groups_claim: string;
  admin_group: string;
  /** DCIM/IPAM role of accounts the provider creates. */
  role: NetboxRole;
}

const empty = (): Provider => ({
  enabled: false,
  title: '',
  issuer: '',
  client_id: '',
  team_id: '',
  key_id: '',
  allowed_domains: [],
  existing_only: false,
  scopes: '',
  groups_claim: '',
  admin_group: '',
  role: 'viewer',
});

export function providers(): Record<ProviderKind, Provider> {
  const stored = readSetting<Partial<Record<ProviderKind, Partial<Provider>>>>(PROVIDERS_KEY, {});
  return {
    google: { ...empty(), ...stored.google, issuer: GOOGLE_ISSUER },
    apple: { ...empty(), ...stored.apple, issuer: APPLE_ISSUER },
    oidc: { ...empty(), ...stored.oidc },
  };
}

export const providerTitle = (kind: ProviderKind, p: Provider) => (kind === 'google' ? 'Google' : kind === 'apple' ? 'Apple' : p.title || 'OpenID Connect');

export const providerRedirect = (base: string, kind: ProviderKind) => `${base}/api/v1/auth/sso/${kind}/callback`;

export async function providersView(base: string) {
  const all = providers();
  const out = [];
  for (const kind of PROVIDER_KINDS) {
    out.push({
      kind,
      config: all[kind],
      client_secret_set: !!(await getSecret(secretPath(kind), 'client_secret')),
      private_key_set: !!(await getSecret(secretPath(kind), 'private_key')),
      redirect_uri: base ? providerRedirect(base, kind) : '',
    });
  }
  return { public_url: base, providers: out };
}

export async function saveProvider(kind: ProviderKind, input: Provider, clientSecret: string, privateKey: string, userId: string) {
  const p: Provider = { ...empty(), ...input };
  p.client_id = p.client_id.trim();
  p.allowed_domains = [...new Set(p.allowed_domains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  for (const d of p.allowed_domains) if (!d.includes('.') || /[\s/:@]/.test(d)) throw new HttpError(400, 'PROVIDER_DOMAIN', `${d} is not a domain name`);
  if (kind === 'google') p.issuer = GOOGLE_ISSUER;
  else if (kind === 'apple') p.issuer = APPLE_ISSUER;
  else {
    let url: URL;
    try {
      url = new URL(p.issuer.trim().replace(/\/+$/, ''));
    } catch {
      throw new HttpError(400, 'PROVIDER_ISSUER', 'The issuer must be an https:// address');
    }
    if (url.protocol !== 'https:') throw new HttpError(400, 'PROVIDER_ISSUER', 'The issuer must be an https:// address');
    p.issuer = url.toString().replace(/\/+$/, '');
  }
  if (p.enabled) {
    if (!p.client_id) throw new HttpError(400, 'PROVIDER_CLIENT', 'Enter the client ID');
    if (kind !== 'oidc' && !p.allowed_domains.length && !p.existing_only)
      throw new HttpError(400, 'PROVIDER_DOMAINS', 'Enter the allowed e-mail domains or allow only existing accounts');
    if (kind === 'apple' && (!p.team_id || !p.key_id)) throw new HttpError(400, 'PROVIDER_APPLE', 'Enter the Team ID and the Key ID');
    try {
      await discover(p.issuer);
    } catch (e) {
      throw new HttpError(400, 'PROVIDER_UNAVAILABLE', (e as Error).message);
    }
    if (kind === 'apple') {
      const key = privateKey || (await getSecret(secretPath(kind), 'private_key'));
      if (!key) throw new HttpError(400, 'PROVIDER_KEY', 'Upload the private key (.p8)');
      try {
        await appleSecret(p.team_id, p.key_id, p.client_id, key);
      } catch (e) {
        throw new HttpError(400, 'PROVIDER_KEY', (e as Error).message);
      }
    } else if (!clientSecret && !(await getSecret(secretPath(kind), 'client_secret'))) throw new HttpError(400, 'PROVIDER_SECRET', 'Enter the client secret');
  }
  if (clientSecret || privateKey) await setSecret(secretPath(kind), { ...(clientSecret ? { client_secret: clientSecret } : {}), ...(privateKey ? { private_key: privateKey } : {}) });
  const all = readSetting<Record<string, Provider>>(PROVIDERS_KEY, {});
  writeSetting(PROVIDERS_KEY, { ...all, [kind]: p }, userId);
  logEvent('warn', `Sign-in provider ${kind} changed`, { enabled: p.enabled, client_id: p.client_id });
  return p;
}

export async function providerClient(kind: ProviderKind, base: string): Promise<{ client: Client; provider: Provider }> {
  const p = providers()[kind];
  if (!p.enabled) throw badRequest('This sign-in method is turned off');
  const secret =
    kind === 'apple'
      ? await appleSecret(p.team_id, p.key_id, p.client_id, (await getSecret(secretPath(kind), 'private_key')) ?? '')
      : ((await getSecret(secretPath(kind), 'client_secret')) ?? '');
  const extra: Record<string, string> = {};
  let scopes = ['openid', 'email', 'profile'];
  if (kind === 'google') {
    extra.prompt = 'select_account';
    if (p.allowed_domains.length === 1) extra.hd = p.allowed_domains[0];
  } else if (kind === 'apple') {
    scopes = ['openid', 'email', 'name'];
    extra.response_mode = 'form_post';
  } else scopes = [...scopes, ...p.scopes.split(/\s+/).filter(Boolean)];
  return { client: { issuer: p.issuer, clientId: p.client_id, secret, redirectUri: providerRedirect(base, kind), scopes, extra }, provider: p };
}

/** Finishes a provider sign-in and returns the account. */
export async function completeProvider(kind: ProviderKind, base: string, code: string, req: Request, appleUser?: string): Promise<User> {
  const { client, provider: p } = await providerClient(kind, base);
  const t = await exchange(client, code, req);
  const cl = await verify(client, t.id_token, req.nonce);
  const email = String(cl.email ?? '').trim().toLowerCase();
  const verified = cl.email_verified === true || cl.email_verified === 'true' || (kind === 'oidc' && cl.email_verified === undefined && !!email);
  if (!cl.sub || !email || !verified) throw new HttpError(403, 'PROVIDER_NOT_ALLOWED', 'The provider gave no verified e-mail address');
  const domain = email.split('@').pop() ?? '';
  if (p.allowed_domains.length && !p.allowed_domains.includes(domain)) throw new HttpError(403, 'PROVIDER_NOT_ALLOWED', `The domain of ${email} is not allowed`);
  if (kind === 'google' && p.allowed_domains.length && !p.allowed_domains.includes(String(cl.hd ?? '').toLowerCase()))
    throw new HttpError(403, 'PROVIDER_NOT_ALLOWED', `${email} is not a Workspace account of an allowed domain`);
  const bound = accountByExternal(kind, cl.sub);
  if (bound) {
    if (bound.disabled) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
    return bound;
  }
  const same = accountByEmail(email);
  if (same) {
    if (same.disabled) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
    logEvent('warn', 'Account signed in through a provider by its e-mail', { provider: kind, email });
    return same;
  }
  if (p.existing_only) throw new HttpError(403, 'PROVIDER_NOT_ALLOWED', `${email} has no Inventory DB account`);
  let name = String(cl.name ?? '');
  if (kind === 'apple' && appleUser) {
    try {
      const u = JSON.parse(appleUser) as { name?: { firstName?: string; lastName?: string } };
      name = `${u.name?.firstName ?? ''} ${u.name?.lastName ?? ''}`.trim();
    } catch {
      // the name comes only with the first sign-in
    }
  }
  let role = p.role;
  if (p.groups_claim && p.admin_group && strings(cl[p.groups_claim]).some((g) => g.toLowerCase() === p.admin_group.toLowerCase())) role = 'admin';
  return upsertAccount({ source: kind, externalId: cl.sub, email, name: name || email, role }).user;
}
