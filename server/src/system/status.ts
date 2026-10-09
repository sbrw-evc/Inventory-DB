/** System status page: build, runtime, PostgreSQL, OpenBao, directory sign-in, integrations, counts and recent errors. */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { accountStats, activeEntra, entraClientSecret, getEntraConfig, getLdapConfig, ldapBindPassword, usersBySource } from '../auth/directory.js';
import { entraPing } from '../auth/entra.js';
import { ldapPing, normalizeLdap, tlsMode } from '../auth/ldap.js';
import { getPolicy, policySummary } from '../auth/policy.js';
import { getDb, q } from '../db/index.js';
import { models } from '../netbox/registry.js';
import { recentLogs } from './logbuf.js';
import { postgresHealth } from './postgres.js';
import { localSecretCount, openBaoClient, secretBackend } from './secrets.js';

const startedAt = new Date();
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

function appVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'package.json');
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === '@inventory-db/server') return pkg.version ?? '0.0.0';
    }
    dir = dirname(dir);
  }
  return process.env.npm_package_version ?? 'dev';
}
const VERSION = appVersion();

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string; ms: number }> {
  const t = performance.now();
  try {
    return { value: await fn(), ms: Math.round(performance.now() - t) };
  } catch (e) {
    return { error: (e as Error).message, ms: Math.round(performance.now() - t) };
  }
}

const tableOf = (type: string) => models.find((m) => m.type === type)?.table;
const objects = (type: string) => {
  const table = tableOf(type);
  return table ? count(`SELECT COUNT(*) n FROM ${q(table)}`) : 0;
};

const count = (sql: string) => {
  try {
    return Number((getDb().prepare(sql).get() as { n: number }).n);
  } catch {
    return 0;
  }
};

async function ldapStatus() {
  const c = getLdapConfig();
  if (!c.enabled) return { enabled: false, ok: false, latency_ms: 0 };
  const base = { enabled: true, kind: c.kind, url: c.url, tls: tlsMode(c), base_dn: c.base_dn, admin_group: c.admin_group_dn || undefined };
  const r = await timed(async () => ldapPing(normalizeLdap(c), await ldapBindPassword()));
  return { ...base, ok: !r.error, latency_ms: r.ms, error: r.error };
}

async function entraStatus() {
  const c = getEntraConfig();
  if (!c.enabled) return { enabled: false, ok: false, credentials: false, latency_ms: 0 };
  const active = activeEntra();
  const base = {
    enabled: true,
    cloud: c.cloud,
    tenant_id: c.tenant_id,
    client_id: c.client_id,
    redirect_url: c.redirect_url,
    admin_group_id: c.admin_group_id || undefined,
    user_group_id: c.user_group_id || undefined,
    credentials: !!(await entraClientSecret().catch(() => '')),
  };
  if (!active) return { ...base, ok: false, latency_ms: 0, error: 'The settings are incomplete' };
  const r = await timed(() => entraPing(active));
  return { ...base, issuer: r.value, ok: !r.error && base.credentials, latency_ms: r.ms, error: r.error ?? (base.credentials ? undefined : 'The client secret is not set') };
}

export async function systemStatus() {
  const mem = process.memoryUsage();
  const client = openBaoClient();
  const [openbao, ldap, entra] = await Promise.all([
    client ? client.status() : Promise.resolve(null),
    ldapStatus(),
    entraStatus(),
  ]);
  const policy = getPolicy();
  const integrations = getDb()
    .prepare("SELECT COUNT(*) total, COUNT(*) FILTER (WHERE active = 1) active, MAX(config::jsonb ->> 'lastFeedAt') last_feed, MAX(config::jsonb ->> 'lastAlertAt') last_alert FROM nc_integrations")
    .get() as { total: number; active: number; last_feed: string | null; last_alert: string | null };
  const accounts = accountStats();
  return {
    checked_at: new Date().toISOString(),
    version: VERSION,
    build: { version: VERSION, commit: process.env.GIT_COMMIT || undefined, node_version: process.version, platform: `${process.platform}/${process.arch}` },
    runtime: {
      started_at: startedAt.toISOString(),
      uptime_seconds: Math.round(process.uptime()),
      hostname: os.hostname(),
      pid: process.pid,
      cpus: os.cpus().length,
      load: os.loadavg().map((n) => Math.round(n * 100) / 100),
      event_loop_delay_ms: Math.round((loop.mean / 1e6) * 10) / 10,
      memory: { rss_bytes: mem.rss, heap_used_bytes: mem.heapUsed, heap_total_bytes: mem.heapTotal, external_bytes: mem.external },
      system_memory: { total_bytes: os.totalmem(), free_bytes: os.freemem() },
    },
    secrets: { backend: secretBackend(), local: localSecretCount() },
    openbao: openbao ?? { configured: false, reachable: false, token_ok: false, mount_ok: false, renewable: false, latency_ms: 0 },
    postgres: postgresHealth(),
    ldap,
    entra,
    integrations: { total: integrations.total, active: integrations.active, last_feed_at: integrations.last_feed ?? undefined, last_alert_at: integrations.last_alert ?? undefined },
    settings: { password_policy: policy, ...policySummary(policy) },
    inventory: {
      users: usersBySource(),
      admins: accounts.admins,
      disabled_users: accounts.disabled,
      last_sign_in: accounts.last_sign_in,
      bases: count('SELECT COUNT(*) n FROM nc_bases'),
      tables: count('SELECT COUNT(*) n FROM nc_tables'),
      api_tokens: count('SELECT COUNT(*) n FROM nc_api_tokens'),
      webhooks: count('SELECT COUNT(*) n FROM nc_hooks'),
      audit_entries: count('SELECT COUNT(*) n FROM nc_audit'),
      sites: objects('dcim.site'),
      devices: objects('dcim.device'),
      prefixes: objects('ipam.prefix'),
      ip_addresses: objects('ipam.ipaddress'),
    },
    logs: recentLogs(),
  };
}
