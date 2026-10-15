import type { PasswordPolicy } from '@shared';
import { http } from '../api/client';

export type State = 'ok' | 'warn' | 'error' | 'off';
export type SecretBackend = 'openbao' | 'local';
export type AccountStats = { total: number; admins: number; disabled: number; last_sign_in?: string };

// ---- LDAP / AD and Entra ID ----
export type LdapKind = 'ad' | 'openldap';
export interface LdapConfig {
  enabled: boolean;
  kind: LdapKind;
  url: string;
  start_tls: boolean;
  skip_verify: boolean;
  ca_cert: string;
  bind_dn: string;
  base_dn: string;
  user_filter: string;
  username_attr: string;
  name_attr: string;
  email_attr: string;
  admin_group_dn: string;
}
export interface LdapView {
  config: LdapConfig;
  bind_password_set: boolean;
  local_admins: number;
  users: AccountStats;
  secrets: SecretBackend;
}
export interface LdapReport {
  ok: boolean;
  error?: string;
  probe?: {
    server: string;
    tls: 'ldaps' | 'starttls' | 'none';
    base_dn: string;
    admin_group: boolean;
    user_authenticated: boolean;
    user?: { dn: string; username: string; name: string; email: string; admin: boolean };
  };
}

export type EntraCloud = 'global' | 'usgov' | 'china';
export interface EntraConfig {
  enabled: boolean;
  cloud: EntraCloud;
  tenant_id: string;
  client_id: string;
  redirect_url: string;
  admin_group_id: string;
  user_group_id: string;
}
export interface EntraView {
  config: EntraConfig;
  client_secret_set: boolean;
  local_admins: number;
  users: AccountStats;
  secrets: SecretBackend;
}
export interface EntraReport {
  ok: boolean;
  error?: string;
  probe?: { issuer?: string; tenant_id?: string; credentials: boolean };
}

// ---- Password policy ----
export interface PolicySummary {
  policy: PasswordPolicy;
  local_users: number;
  expired_users: number;
  expiring_users: number;
  /** The policy comes from Umbrella Monitoring and is read-only here. */
  managed_by_hub?: boolean;
}

// ---- Umbrella Identity: passkeys, providers, single sign-in ----
export type IdbRole = 'admin' | 'editor' | 'viewer';
export type MappedRole = IdbRole | 'none';
export interface PasskeySettings {
  enabled: boolean;
  rp_id: string;
  from_hub: boolean;
  effective_rp_id: string;
}
export type ProviderKind = 'google' | 'apple' | 'oidc';
export interface ProviderConfig {
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
  role: IdbRole;
}
export interface ProvidersView {
  public_url: string;
  providers: { kind: ProviderKind; config: ProviderConfig; client_secret_set: boolean; private_key_set: boolean; redirect_uri: string }[];
}
export interface UmbrellaView {
  enabled: boolean;
  connected: boolean;
  hub: string;
  client_id: string;
  application: string;
  role_map: { match: string; role: IdbRole }[];
  admin_role: MappedRole;
  default_role: MappedRole;
  link_local: boolean;
  sso: boolean;
  sync_users: boolean;
  sync_policy: boolean;
  sync_passkeys: boolean;
  methods: { id: string; title: string }[];
  hub_passkeys: { enabled: boolean; rp_id: string };
  status: { last_sync?: string; ok: boolean; error?: string; users: number; created: number; updated: number; disabled: number; conflicts: string[] };
  public_url: string;
  redirect_uri: string;
}
export interface UmbrellaCheck {
  hub: string;
  application: string;
  methods: { id: string; title: string }[];
  passkeys: { enabled: boolean; rp_id: string };
  passkeys_here: boolean;
  users: number;
  roles: string[];
  groups: string[];
  conflicts: string[];
}
export type UmbrellaInput = Pick<UmbrellaView, 'enabled' | 'role_map' | 'admin_role' | 'default_role' | 'link_local' | 'sso' | 'sync_users' | 'sync_policy' | 'sync_passkeys'> & {
  key?: string;
};

// ---- PostgreSQL ----
export type SslMode = 'disable' | 'require' | 'verify-full';
export interface PgConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  sslmode: SslMode;
}
export interface PostgresOverview {
  connection: PgConnection;
  schema: string | null;
  where: string;
  source: 'settings' | 'environment';
  password_in: 'openbao' | 'file' | 'environment';
  ok: boolean;
  info: { version?: string; schema?: string; size_bytes?: number };
  error?: string;
}
export interface PostgresTest {
  ok: boolean;
  version?: string;
  latency_ms: number;
  error?: string;
}
export interface DatabaseStats {
  name: string;
  size_bytes: number;
  backends: number;
  xact_commit: number;
  xact_rollback: number;
  blks_read: number;
  blks_hit: number;
  tup_returned: number;
  tup_fetched: number;
  tup_inserted: number;
  tup_updated: number;
  tup_deleted: number;
  conflicts: number;
  deadlocks: number;
  temp_files: number;
  temp_bytes: number;
  stats_reset?: string;
}
export interface TableSize {
  schema: string;
  name: string;
  total_bytes: number;
  table_bytes: number;
  index_bytes: number;
  rows: number;
  dead_rows: number;
}
export interface Operation {
  pid: number;
  database: string;
  user: string;
  application: string;
  client: string;
  backend_type: string;
  state: string;
  wait_event_type: string;
  wait_event: string;
  started?: string;
  duration_ms: number;
  query: string;
  truncated: boolean;
}
export interface Statement {
  query_id: string;
  query: string;
  calls: number;
  total_ms: number;
  mean_ms: number;
  rows: number;
}
export interface PostgresStats {
  collected_at: string;
  full_visibility: boolean;
  database: DatabaseStats;
  table_count: number;
  tables: TableSize[];
  operations: Operation[];
  statements: { installed: boolean; error?: string; by_total: Statement[] | null; by_mean: Statement[] | null };
}
export interface PgTarget extends PgConnection {
  password: string;
}
export interface PostgresReport {
  ok: boolean;
  error?: string;
  probe: { version: string; database: string; user: string; schema: string; can_create: boolean; has_state: boolean; saved_at?: string } | null;
}

// ---- OpenBao ----
export interface OpenBaoStatus {
  configured: boolean;
  addr?: string;
  mount?: string;
  namespace?: string;
  auth?: string;
  reachable: boolean;
  initialized?: boolean;
  sealed?: boolean;
  version?: string;
  cluster_name?: string;
  token_ok: boolean;
  mount_ok: boolean;
  renewable: boolean;
  token_expires?: string;
  policies?: string[];
  error?: string;
  last_error?: string;
  last_error_at?: string;
  latency_ms: number;
}
export interface OpenBaoOverview {
  configured: boolean;
  backend: SecretBackend;
  connection?: { addr: string; mount: string; namespace?: string; auth: 'token' | 'approle'; approle_path?: string; custom_ca: boolean; skip_verify: boolean; source: 'settings' | 'environment' };
  status?: OpenBaoStatus;
  secrets: number;
  local_secrets: number;
  list_error?: string;
}
export interface OpenBaoTarget {
  addr: string;
  mount: string;
  namespace?: string;
  auth: 'token' | 'approle';
  token?: string;
  role_id?: string;
  secret_id?: string;
  approle_path?: string;
  ca_cert?: string;
  skip_verify: boolean;
}
export interface OpenBaoReport {
  ok: boolean;
  error?: string;
  write_ok: boolean;
  write_error?: string;
  status: OpenBaoStatus;
  secrets?: number;
}
export type SecretUsage = 'integration' | 'ldap' | 'entra' | 'postgres' | 'jwt' | 'other';
export interface SecretItem {
  path: string;
  keys: string[];
  usage: SecretUsage;
  title?: string;
}

// ---- System status ----
export interface LogEntry {
  at: string;
  level: 'warn' | 'error';
  message: string;
  attrs?: Record<string, string>;
}
export interface SystemStatus {
  checked_at: string;
  version: string;
  build: { version: string; commit?: string; node_version: string; platform: string };
  runtime: {
    started_at: string;
    uptime_seconds: number;
    hostname: string;
    pid: number;
    cpus: number;
    load: number[];
    event_loop_delay_ms: number;
    memory: { rss_bytes: number; heap_used_bytes: number; heap_total_bytes: number; external_bytes: number };
    system_memory: { total_bytes: number; free_bytes: number };
  };
  secrets: { backend: SecretBackend; local: number };
  openbao: OpenBaoStatus;
  postgres: {
    where: string;
    ok: boolean;
    latency_ms: number;
    error?: string;
    health?: { version: string; database: string; user: string; size_bytes: number; started_at: string; connections: number; max_connections: number; ssl: boolean };
  };
  ldap: { enabled: boolean; ok: boolean; kind?: LdapKind; url?: string; tls?: string; base_dn?: string; admin_group?: string; latency_ms: number; error?: string };
  entra: {
    enabled: boolean;
    ok: boolean;
    cloud?: EntraCloud;
    tenant_id?: string;
    client_id?: string;
    redirect_url?: string;
    admin_group_id?: string;
    user_group_id?: string;
    issuer?: string;
    credentials: boolean;
    latency_ms: number;
    error?: string;
  };
  integrations: { total: number; active: number; last_feed_at?: string; last_alert_at?: string };
  settings: { password_policy: PasswordPolicy } & Omit<PolicySummary, 'policy'>;
  inventory: {
    users: Record<'local' | 'ldap' | 'entra', number>;
    admins: number;
    disabled_users: number;
    last_sign_in?: string;
    bases: number;
    tables: number;
    api_tokens: number;
    webhooks: number;
    audit_entries: number;
    sites: number;
    devices: number;
    prefixes: number;
    ip_addresses: number;
  };
  logs: { counts: Record<'warn' | 'error', number>; recent: LogEntry[] };
}

const S = '/settings';
export const settingsApi = {
  status: () => http.get<SystemStatus>('/system/status'),
  ldap: () => http.get<LdapView>(`${S}/ldap`),
  saveLdap: (body: { config: Partial<LdapConfig>; bind_password?: string }) => http.put<LdapView>(`${S}/ldap`, body),
  testLdap: (body: { config: LdapConfig; bind_password?: string; test_username?: string; test_password?: string }) => http.post<LdapReport>(`${S}/ldap/test`, body),
  entra: () => http.get<EntraView>(`${S}/entra`),
  saveEntra: (body: { config: Partial<EntraConfig>; client_secret?: string }) => http.put<EntraView>(`${S}/entra`, body),
  testEntra: (body: { config: EntraConfig; client_secret?: string }) => http.post<EntraReport>(`${S}/entra/test`, body),
  policy: () => http.get<PolicySummary>(`${S}/password-policy`),
  savePolicy: (p: PasswordPolicy) => http.put<PolicySummary>(`${S}/password-policy`, p),
  postgres: () => http.get<PostgresOverview>(`${S}/postgres`),
  testPostgres: () => http.post<PostgresTest>(`${S}/postgres/test`),
  postgresStats: () => http.get<PostgresStats>(`${S}/postgres/stats`),
  probePostgres: (t: PgTarget) => http.post<PostgresReport>(`${S}/postgres/probe`, t),
  migratePostgres: (target: PgTarget, overwrite: boolean) => http.post<{ where: string; tables: number; rows: number }>(`${S}/postgres/migrate`, { target, overwrite }),
  openbao: () => http.get<OpenBaoOverview>(`${S}/openbao`),
  secrets: () => http.get<SecretItem[]>(`${S}/openbao/secrets`),
  testOpenBao: () => http.post<OpenBaoReport>(`${S}/openbao/test`),
  probeOpenBao: (t: OpenBaoTarget) => http.post<OpenBaoReport>(`${S}/openbao/probe`, t),
  migrateOpenBao: (target: OpenBaoTarget, overwrite: boolean) => http.post<{ addr: string; mount: string; copied: number }>(`${S}/openbao/migrate`, { target, overwrite }),
  moveLocalSecrets: () => http.post<{ moved: number }>(`${S}/openbao/move-local`),
  passkeys: () => http.get<PasskeySettings>(`${S}/passkeys`),
  savePasskeys: (body: { enabled: boolean; rp_id: string }) => http.put<PasskeySettings>(`${S}/passkeys`, body),
  savePublicUrl: (public_url: string) => http.put<{ public_url: string }>(`${S}/public-url`, { public_url }),
  providers: () => http.get<ProvidersView>(`${S}/providers`),
  saveProvider: (kind: ProviderKind, config: ProviderConfig, secrets: { client_secret?: string; private_key?: string }) =>
    http.put<ProvidersView>(`${S}/providers/${kind}`, { config, ...secrets }),
  umbrella: () => http.get<UmbrellaView>(`${S}/identity`),
  checkUmbrella: (key: string) => http.post<UmbrellaCheck>(`${S}/identity/check`, { key }),
  saveUmbrella: (body: UmbrellaInput) => http.put<UmbrellaView>(`${S}/identity`, body),
  syncUmbrella: () => http.post<UmbrellaView>(`${S}/identity/sync`),
  disconnectUmbrella: () => http.del<UmbrellaView>(`${S}/identity`),
};
