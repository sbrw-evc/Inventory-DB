/**
 * Settings section (administrators only): system status, the SPA connection (sign-in and access are managed in SPA),
 * PostgreSQL and OpenBao. Mirrors Umbrella's /api/settings/* endpoints.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadKey, SPA_CALLBACK, publicBase } from '../auth/spa/connection.js';
import { spaState, syncSpa, type SpaState } from '../auth/spa/sync.js';
import { listUsers, userCounts } from '../auth/spa/users.js';
import { HttpError, conflict } from '../errors.js';
import { requireNetboxRole } from '../netbox/access.js';
import { DEFAULT_MOUNT, PG_SSL_MODES, type OpenBaoConnection } from '../system/config.js';
import { migrateOpenBao, openBaoOverview, probeOpenBao, secretList, testOpenBao } from '../system/openbaoSettings.js';
import { migratePostgres, postgresOverview, postgresStats, postgresTest, probePostgres } from '../system/postgres.js';
import { moveLocalSecretsToOpenBao, secretBackend } from '../system/secrets.js';
import { systemStatus } from '../system/status.js';

const requireAdmin = (req: FastifyRequest) => requireNetboxRole(req, 'admin').user;

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

/** The SPA connection for the settings page: issuer, application, last synchronization, counts and errors. */
async function spaView(req: FastifyRequest) {
  const { key, source, error } = await loadKey();
  const base = publicBase(req);
  const s: SpaState = spaState(key);
  return {
    connected: !!key,
    key_source: source,
    key_error: error,
    issuer: key?.issuer ?? null,
    client_id: key?.client_id ?? null,
    redirect_uri: `${base}${SPA_CALLBACK}`,
    public_url: base,
    application: s.config?.application ?? null,
    account_url: s.config?.account_url ?? null,
    sign_out_url: s.config?.sign_out_url ?? null,
    spa_roles: s.config?.roles ?? [],
    methods: s.config?.methods ?? [],
    roles_published_at: s.roles_published_at ?? null,
    roles_error: s.roles_error ?? null,
    last_sync: s.last_sync ?? null,
    last_success: s.last_success ?? null,
    ok: s.ok,
    error: key ? (s.error ?? null) : (error ?? null),
    counts: s.counts,
    users: userCounts(),
  };
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/v1/system/status', async (req) => {
    requireAdmin(req);
    return systemStatus();
  });

  // ---- SPA (sign-in and access are managed there) ----
  app.get('/api/v1/settings/spa', async (req) => {
    requireAdmin(req);
    return spaView(req);
  });

  app.post('/api/v1/settings/spa/sync', async (req) => {
    const user = requireAdmin(req);
    const { key } = await loadKey();
    if (!key) throw new HttpError(409, 'SPA_NOT_CONNECTED', 'Inventory DB is not connected to SPA');
    await syncSpa(user.email || user.id, { force: true });
    return spaView(req);
  });

  app.get('/api/v1/settings/spa/users', async (req) => {
    requireAdmin(req);
    return listUsers().map((u) => ({ ...u, disabled: !!u.disabled }));
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
