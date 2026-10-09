/**
 * Metadata schema. Append new migrations; never edit applied ones.
 * User data lives in generated tables: t_<tableId> (records), l_<columnId> (link junctions).
 */
export const migrations: string[] = [
  `
  CREATE TABLE nc_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nc_api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES nc_users(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nc_bases (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    color TEXT,
    "order" REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nc_base_members (
    base_id TEXT NOT NULL REFERENCES nc_bases(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES nc_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','editor','commenter','viewer')),
    PRIMARY KEY (base_id, user_id)
  );

  CREATE TABLE nc_tables (
    id TEXT PRIMARY KEY,
    base_id TEXT NOT NULL REFERENCES nc_bases(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    "order" REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nc_columns (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES nc_tables(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    required INTEGER NOT NULL DEFAULT 0,
    default_value TEXT,
    description TEXT,
    options TEXT NOT NULL DEFAULT '{}',
    "order" REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nc_views (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES nc_tables(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    "order" REAL NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    filter TEXT,
    sorts TEXT NOT NULL DEFAULT '[]',
    columns TEXT NOT NULL DEFAULT '[]',
    meta TEXT NOT NULL DEFAULT '{}',
    share_uuid TEXT UNIQUE,
    share_password_hash TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nc_comments (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES nc_tables(id) ON DELETE CASCADE,
    record_id INTEGER NOT NULL,
    user_id TEXT NOT NULL REFERENCES nc_users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX nc_comments_record ON nc_comments(table_id, record_id);

  CREATE TABLE nc_audit (
    id TEXT PRIMARY KEY,
    base_id TEXT NOT NULL,
    table_id TEXT,
    record_id INTEGER,
    user_id TEXT,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX nc_audit_record ON nc_audit(table_id, record_id);
  CREATE INDEX nc_audit_base ON nc_audit(base_id, created_at);

  CREATE TABLE nc_hooks (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES nc_tables(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    event TEXT NOT NULL,
    url TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'POST',
    headers TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    condition TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nc_hook_logs (
    id TEXT PRIMARY KEY,
    hook_id TEXT NOT NULL REFERENCES nc_hooks(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    status INTEGER,
    error TEXT,
    payload TEXT,
    response TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nc_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    log TEXT NOT NULL DEFAULT '[]',
    result TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nc_files (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    mimetype TEXT,
    size INTEGER,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // Integrations (Umbrella monitoring): connection settings and alert state pushed by Umbrella.
  `
  CREATE TABLE nc_integrations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}',
    secret_enc TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES nc_users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nc_monitoring_alerts (
    integration_id TEXT NOT NULL REFERENCES nc_integrations(id) ON DELETE CASCADE,
    alert_id TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    signal TEXT,
    incident_url TEXT,
    grafana_url TEXT,
    first_seen TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (integration_id, alert_id, object_type, object_id)
  );
  CREATE INDEX nc_monitoring_alerts_object ON nc_monitoring_alerts(object_type, object_id, status);

  -- Alerts whose CI matched no inventory object; shown to the integration owner to fix identities.
  CREATE TABLE nc_monitoring_unmatched (
    integration_id TEXT NOT NULL REFERENCES nc_integrations(id) ON DELETE CASCADE,
    alert_id TEXT NOT NULL,
    title TEXT NOT NULL,
    ci TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (integration_id, alert_id)
  );
  `,
];
