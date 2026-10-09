/**
 * Settings section (administrators only): system status, LDAP / AD and Entra ID sign-in, PostgreSQL, OpenBao and the
 * password policy. Mirrors Umbrella's /api/settings/* endpoints.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { POLICY_LETTERS, type PasswordPolicy } from '../../../shared/src/passwordPolicy.js';
import {
  ENTRA_KEY,
  ENTRA_SECRET,
  LDAP_KEY,
  LDAP_SECRET,
  accountStats,
  entraClientSecret,
  getEntraConfig,
  getLdapConfig,
  ldapBindPassword,
  localAdmins,
} from '../auth/directory.js';
import { ENTRA_CLOUDS, normalizeEntra, entraTest, type EntraConfig } from '../auth/entra.js';
import { ldapTest, normalizeLdap, type LdapConfig } from '../auth/ldap.js';
import { policySummary, savePolicy } from '../auth/policy.js';
import { HttpError, badRequest, conflict } from '../errors.js';
import { requireNetboxRole } from '../netbox/access.js';
import { DEFAULT_MOUNT, PG_SSL_MODES, type OpenBaoConnection } from '../system/config.js';
import { logEvent } from '../system/logbuf.js';
import { migrateOpenBao, openBaoOverview, probeOpenBao, secretList, testOpenBao } from '../system/openbaoSettings.js';
import { migratePostgres, postgresOverview, postgresStats, postgresTest, probePostgres } from '../system/postgres.js';
import { moveLocalSecretsToOpenBao, secretBackend, setSecret } from '../system/secrets.js';
import { writeSetting } from '../system/settings.js';
import { systemStatus } from '../system/status.js';

const requireAdmin = (req: FastifyRequest) => requireNetboxRole(req, 'admin').user;

const str = (max = 2000) => z.string().max(max).default('');
const ldapSchema = z.object({
  enabled: z.boolean(),
  kind: z.enum(['ad', 'openldap']).default('ad'),
  url: str(),
  start_tls: z.boolean().default(false),
  skip_verify: z.boolean().default(false),
  ca_cert: str(20_000),
  bind_dn: str(),
  base_dn: str(),
  user_filter: str(),
  username_attr: str(64),
  name_attr: str(64),
  email_attr: str(64),
  admin_group_dn: str(),
});
const entraSchema = z.object({
  enabled: z.boolean(),
  cloud: z.enum(ENTRA_CLOUDS as [EntraConfig['cloud'], ...EntraConfig['cloud'][]]).default('global'),
  tenant_id: str(256),
  client_id: str(64),
  redirect_url: str(),
  admin_group_id: str(64),
  user_group_id: str(64),
});
const policySchema = z.object({
  min_length: z.number().int(),
  require_digits: z.boolean(),
  min_digits: z.number().int(),
  require_special: z.boolean(),
  min_special: z.number().int(),
  require_mixed_case: z.boolean(),
  letters: z.enum(POLICY_LETTERS as [PasswordPolicy['letters'], ...PasswordPolicy['letters'][]]),
  max_age_days: z.number().int(),
  warn_days: z.number().int(),
});
const pgTarget = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().trim().min(1).max(63),
  user: z.string().trim().min(1).max(63),
  password: z.string().max(1000).default(''),
  sslmode: z.enum(PG_SSL_MODES as [string, ...string[]]).default('disable') as z.ZodType<'disable' | 'require' | 'verify-full'>,
  schema: z.string().trim().max(63).optional(),
});
const baoTarget = z
  .object({
    addr: z
      .string()
      .trim()
      .regex(/^https?:\/\/[^\s/]+/i, 'OpenBao address must look like https://openbao.example:8200'),
    mount: z.string().trim().max(128).default(DEFAULT_MOUNT),
    namespace: z.string().trim().max(256).optional(),
    auth: z.enum(['token', 'approle']),
    token: z.string().trim().max(2000).optional(),
    role_id: z.string().trim().max(256).optional(),
    secret_id: z.string().trim().max(256).optional(),
    approle_path: z.string().trim().max(128).optional(),
    ca_cert: z.string().trim().max(20_000).optional(),
    skip_verify: z.boolean().default(false),
  })
  .transform((b): OpenBaoConnection => ({
    addr: b.addr.replace(/\/+$/, ''),
    mount: b.mount.replace(/^\/+|\/+$/g, '') || DEFAULT_MOUNT,
    namespace: b.namespace || undefined,
    auth: b.auth,
    token: b.auth === 'token' ? b.token : undefined,
    role_id: b.auth === 'approle' ? b.role_id : undefined,
    secret_id: b.auth === 'approle' ? b.secret_id : undefined,
    approle_path: b.auth === 'approle' ? b.approle_path || 'approle' : undefined,
    ca_cert: b.ca_cert || undefined,
    skip_verify: b.skip_verify,
  }))
  .refine((c) => (c.auth === 'token' ? !!c.token : !!c.role_id && !!c.secret_id), 'Fill in the token, or the AppRole role_id and secret_id');

/** Validation errors of the directory settings read as 400 with the reason. */
function validated<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest((e as Error).message);
  }
}

const sameLdapAccount = (a: Pick<LdapConfig, 'url' | 'bind_dn'>, b: Pick<LdapConfig, 'url' | 'bind_dn'>) =>
  a.url.trim().toLowerCase() === b.url.trim().toLowerCase() && a.bind_dn.trim().toLowerCase() === b.bind_dn.trim().toLowerCase();
const sameEntraApp = (a: EntraConfig, b: EntraConfig) =>
  a.cloud === b.cloud && a.tenant_id.trim().toLowerCase() === b.tenant_id.trim().toLowerCase() && a.client_id.trim().toLowerCase() === b.client_id.trim().toLowerCase();

async function ldapView() {
  const config = getLdapConfig();
  return { config, bind_password_set: !!(await ldapBindPassword()), local_admins: localAdmins(), users: accountStats('ldap'), secrets: secretBackend() };
}

async function entraView() {
  return { config: getEntraConfig(), client_secret_set: !!(await entraClientSecret()), local_admins: localAdmins(), users: accountStats('entra'), secrets: secretBackend() };
}

/** The password typed now, or the saved one when the server and account did not change. */
async function ldapPassword(config: LdapConfig, typed: string | undefined): Promise<string> {
  if (typed) return typed;
  const saved = getLdapConfig();
  const stored = await ldapBindPassword();
  if (stored && sameLdapAccount(config, saved)) return stored;
  throw badRequest('Enter the service account password');
}

async function entraSecret(config: EntraConfig, typed: string | undefined): Promise<string> {
  if (typed) return typed;
  const stored = await entraClientSecret();
  if (stored && sameEntraApp(config, getEntraConfig())) return stored;
  throw badRequest('Enter the client secret');
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/v1/system/status', async (req) => {
    requireAdmin(req);
    return systemStatus();
  });

  // ---- LDAP / Active Directory ----
  app.get('/api/v1/settings/ldap', async (req) => {
    requireAdmin(req);
    return ldapView();
  });

  app.put('/api/v1/settings/ldap', async (req) => {
    const user = requireAdmin(req);
    const body = z.object({ config: ldapSchema.partial({ kind: true }).passthrough(), bind_password: z.string().max(1000).optional() }).parse(req.body);
    const saved = getLdapConfig();
    if (!body.config.enabled) {
      if (saved.enabled && localAdmins() === 0) throw conflict('Turning LDAP off would leave no administrator who can sign in');
      writeSetting(LDAP_KEY, { ...saved, enabled: false }, user.id);
      return ldapView();
    }
    const config = validated(() => normalizeLdap(ldapSchema.parse(body.config) as LdapConfig));
    const password = await ldapPassword(config, body.bind_password);
    await setSecret(LDAP_SECRET, { bind_password: password });
    writeSetting(LDAP_KEY, config, user.id);
    logEvent('warn', 'LDAP sign-in settings changed', { by: user.email, enabled: true, url: config.url });
    return ldapView();
  });

  app.post('/api/v1/settings/ldap/test', async (req) => {
    requireAdmin(req);
    const body = z
      .object({ config: ldapSchema, bind_password: z.string().max(1000).optional(), test_username: z.string().max(256).optional(), test_password: z.string().max(1000).optional() })
      .parse(req.body);
    const config = validated(() => normalizeLdap({ ...(body.config as LdapConfig), enabled: true }));
    const password = await ldapPassword(config, body.bind_password);
    try {
      return { ok: true, probe: await ldapTest(config, password, body.test_username?.trim() || undefined, body.test_password) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // ---- Microsoft Entra ID ----
  app.get('/api/v1/settings/entra', async (req) => {
    requireAdmin(req);
    return entraView();
  });

  app.put('/api/v1/settings/entra', async (req) => {
    const user = requireAdmin(req);
    const body = z.object({ config: entraSchema.partial().passthrough(), client_secret: z.string().max(2000).optional() }).parse(req.body);
    const saved = getEntraConfig();
    if (!body.config.enabled) {
      if (saved.enabled && localAdmins() === 0) throw conflict('Turning Entra ID off would leave no administrator who can sign in');
      writeSetting(ENTRA_KEY, { ...saved, enabled: false }, user.id);
      return entraView();
    }
    const config = validated(() => normalizeEntra(entraSchema.parse(body.config) as EntraConfig));
    const secret = await entraSecret(config, body.client_secret);
    await setSecret(ENTRA_SECRET, { client_secret: secret });
    writeSetting(ENTRA_KEY, config, user.id);
    logEvent('warn', 'Entra ID sign-in settings changed', { by: user.email, enabled: true, tenant: config.tenant_id });
    return entraView();
  });

  app.post('/api/v1/settings/entra/test', async (req) => {
    requireAdmin(req);
    const body = z.object({ config: entraSchema, client_secret: z.string().max(2000).optional() }).parse(req.body);
    const config = validated(() => normalizeEntra({ ...(body.config as EntraConfig), enabled: true }));
    const secret = await entraSecret(config, body.client_secret);
    try {
      return { ok: true, probe: await entraTest(config, secret) };
    } catch (e) {
      return { ok: false, error: (e as Error).message, probe: { credentials: false } };
    }
  });

  // ---- Password policy ----
  app.get('/api/v1/settings/password-policy', async (req) => {
    requireAdmin(req);
    return policySummary();
  });

  app.put('/api/v1/settings/password-policy', async (req) => {
    const user = requireAdmin(req);
    const policy = savePolicy(policySchema.parse(req.body), user.id);
    logEvent('warn', 'Password policy changed', { by: user.email });
    return policySummary(policy);
  });

  // ---- PostgreSQL ----
  app.get('/api/v1/settings/postgres', async (req) => {
    requireAdmin(req);
    return postgresOverview();
  });

  app.post('/api/v1/settings/postgres/test', async (req) => {
    requireAdmin(req);
    return postgresTest();
  });

  app.get('/api/v1/settings/postgres/stats', async (req) => {
    requireAdmin(req);
    try {
      return postgresStats();
    } catch (e) {
      throw new HttpError(500, 'POSTGRES_STATS_FAILED', `PostgreSQL statistics could not be read: ${(e as Error).message}`);
    }
  });

  app.post('/api/v1/settings/postgres/probe', async (req) => {
    requireAdmin(req);
    return probePostgres(pgTarget.parse(req.body));
  });

  app.post('/api/v1/settings/postgres/migrate', async (req) => {
    const user = requireAdmin(req);
    const body = z.object({ target: pgTarget, overwrite: z.boolean().default(false) }).parse(req.body);
    return migratePostgres(body.target, body.overwrite, user.email);
  });

  // ---- OpenBao ----
  app.get('/api/v1/settings/openbao', async (req) => {
    requireAdmin(req);
    return openBaoOverview();
  });

  app.get('/api/v1/settings/openbao/secrets', async (req) => {
    requireAdmin(req);
    return secretList();
  });

  app.post('/api/v1/settings/openbao/test', async (req) => {
    requireAdmin(req);
    return testOpenBao();
  });

  app.post('/api/v1/settings/openbao/probe', async (req) => {
    requireAdmin(req);
    return probeOpenBao(baoTarget.parse(req.body));
  });

  app.post('/api/v1/settings/openbao/migrate', async (req) => {
    const user = requireAdmin(req);
    const body = z.object({ target: baoTarget, overwrite: z.boolean().default(false) }).parse(req.body);
    return migrateOpenBao(body.target, body.overwrite, user.email);
  });

  /** Secrets left in the database (from before OpenBao was configured) go to OpenBao. */
  app.post('/api/v1/settings/openbao/move-local', async (req) => {
    requireAdmin(req);
    if (secretBackend() !== 'openbao') throw conflict('OpenBao is not configured');
    return { moved: await moveLocalSecretsToOpenBao() };
  });
}
