/**
 * Metadata schema (PostgreSQL). Append new migrations; never edit applied ones.
 * User data lives in generated tables: t_<tableId> (records), l_<columnId> (link junctions).
 * Timestamps are ISO-8601 text and JSON documents are text, as the API exchanges them.
 */
export const migrations: string[] = [
  `
  CREATE TABLE nc_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX nc_users_email ON nc_users (lower(email));

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
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
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
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
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
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nc_views (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES nc_tables(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    "order" DOUBLE PRECISION NOT NULL DEFAULT 0,
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
    created_at TEXT NOT NULL,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
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
    created_at TEXT NOT NULL,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
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
    created_at TEXT NOT NULL,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
  );

  CREATE TABLE nc_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    progress DOUBLE PRECISION NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    log TEXT NOT NULL DEFAULT '[]',
    result TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE nc_files (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    mimetype TEXT,
    size BIGINT,
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
  // Helpers used by the query and formula compilers. Values in user tables are loosely typed text (dates, JSON),
  // so conversions return NULL instead of failing the whole query on one bad value.
  `
  CREATE FUNCTION nc_num(v text) RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $f$
    SELECT CAST(substring(v FROM '^\\s*([-+]?(\\d+\\.?\\d*|\\.\\d+)([eE][-+]?\\d+)?)') AS double precision)
  $f$;

  CREATE FUNCTION nc_json(v text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $f$
  BEGIN
    RETURN v::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END
  $f$;

  CREATE FUNCTION nc_ts(v text) RETURNS timestamptz LANGUAGE plpgsql STABLE PARALLEL SAFE AS $f$
  BEGIN
    IF v IS NULL OR v !~ '^\\s*\\d{4}-\\d{1,2}-\\d{1,2}' THEN RETURN NULL; END IF;
    RETURN v::timestamptz;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END
  $f$;

  CREATE FUNCTION nc_date(v text) RETURNS date LANGUAGE sql STABLE PARALLEL SAFE AS $f$
    SELECT CAST(nc_ts(v) AS date)
  $f$;

  -- ISO-8601 UTC text, the format DateTime values are stored in.
  CREATE FUNCTION nc_iso(v timestamptz) RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $f$
    SELECT to_char(v AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  $f$;

  -- Elements of a JSON array as text (empty for anything else).
  CREATE FUNCTION nc_json_items(v text) RETURNS TABLE (value text) LANGUAGE sql STABLE PARALLEL SAFE AS $f$
    SELECT e #>> '{}' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(nc_json(v)) = 'array' THEN nc_json(v) ELSE '[]'::jsonb END) e
  $f$;

  -- Scalar values at any depth of a JSON document, with their JSON type.
  CREATE FUNCTION nc_json_leaves(v text) RETURNS TABLE (value text, type text) LANGUAGE sql STABLE PARALLEL SAFE AS $f$
    SELECT e #>> '{}', jsonb_typeof(e) FROM jsonb_path_query(COALESCE(nc_json(v), '[]'::jsonb), 'strict $.**') e
    WHERE jsonb_typeof(e) NOT IN ('array', 'object')
  $f$;
  `,
  // Settings section: account sources (local, LDAP / AD, Entra ID), password ageing, app settings and the local
  // secret store used when OpenBao is not configured.
  `
  ALTER TABLE nc_users
    ADD COLUMN source TEXT NOT NULL DEFAULT 'local',
    ADD COLUMN external_id TEXT,
    ADD COLUMN username TEXT,
    ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN password_changed_at TEXT,
    ADD COLUMN last_sign_in_at TEXT,
    -- 'ldap' / 'entra' when the DCIM/IPAM admin role came from the directory's administrators group.
    ADD COLUMN admin_granted_by TEXT;
  UPDATE nc_users SET password_changed_at = created_at;
  CREATE UNIQUE INDEX nc_users_external ON nc_users (source, external_id) WHERE external_id IS NOT NULL;

  CREATE TABLE nc_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE nc_secrets (
    path TEXT PRIMARY KEY,
    data_enc TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];
