/**
 * PostgreSQL settings page: the current connection, live statistics (pg_stat_*), a check of another database and
 * moving all data to it (Umbrella's "Move to another database").
 */
import pg from 'pg';
import { type DB, configureDatabase, connectDb, getDb, openDb, q, setDb } from '../db/index.js';
import { HttpError } from '../errors.js';
import { type PostgresConnection, parsePostgresUrl, postgresUrl, readConfig, writeConfig } from './config.js';
import { logEvent } from './logbuf.js';
import { secretBackend, setSecret } from './secrets.js';

export const PG_PASSWORD_SECRET = 'system/postgres';
const MIN_VERSION = 140000;

export interface PostgresTarget extends PostgresConnection {
  password: string;
  /** Schema to use instead of the user's default (advanced; tests). */
  schema?: string;
}

const where = (c: PostgresConnection) => `${c.user}@${c.host}:${c.port}/${c.database}`;

function currentConnection(db: DB = getDb()) {
  const { connection } = parsePostgresUrl(db.target.url || 'postgres://localhost/');
  return { connection, schema: db.target.schema };
}

/** The current connection without its password, where its settings come from, and whether it answers. */
export function postgresOverview() {
  const db = getDb();
  const { connection, schema } = currentConnection(db);
  const file = readConfig().postgres;
  const out: Record<string, unknown> = {
    connection,
    schema: schema ?? null,
    where: where(connection),
    source: file ? 'settings' : 'environment',
    password_in: file ? file.password_in : 'environment',
    ok: false,
    info: {} as Record<string, unknown>,
  };
  try {
    const info = db.prepare('SELECT version() v, current_setting(\'server_version_num\')::int num, current_schema() s, pg_database_size(current_database()) size').get() as {
      v: string;
      num: number;
      s: string;
      size: number;
    };
    out.ok = true;
    out.info = { version: info.v.split(' ').slice(0, 2).join(' '), version_num: info.num, schema: info.s, size_bytes: info.size };
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

export function postgresTest() {
  const started = performance.now();
  try {
    const row = getDb().prepare("SELECT current_setting('server_version') v").get() as { v: string };
    return { ok: true, version: row.v, latency_ms: Math.round(performance.now() - started) };
  } catch (e) {
    return { ok: false, latency_ms: Math.round(performance.now() - started), error: (e as Error).message };
  }
}

/** Health for the status page: version, size, connections, SSL, latency. */
export function postgresHealth() {
  const db = getDb();
  const { connection } = currentConnection(db);
  const started = performance.now();
  try {
    const r = db
      .prepare(
        `SELECT current_setting('server_version') version, current_database() database, current_user "user",
                pg_database_size(current_database()) size_bytes, pg_postmaster_start_time()::text started_at,
                (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database()) connections,
                current_setting('max_connections')::int max_connections,
                COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) ssl`,
      )
      .get() as Record<string, unknown>;
    return { where: where(connection), ok: true, latency_ms: Math.round(performance.now() - started), health: { ...r, started_at: new Date(String(r.started_at)).toISOString() } };
  } catch (e) {
    return { where: where(connection), ok: false, latency_ms: Math.round(performance.now() - started), error: (e as Error).message };
  }
}

/** pg_stat_database counters, table sizes, the longest running operations and pg_stat_statements. */
export function postgresStats() {
  const db = getDb();
  const database = db
    .prepare(
      `SELECT datname name, pg_database_size(datname) size_bytes, numbackends backends, xact_commit, xact_rollback, blks_read, blks_hit,
              tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, conflicts, deadlocks, temp_files, temp_bytes, stats_reset::text stats_reset
       FROM pg_stat_database WHERE datname = current_database()`,
    )
    .get() as Record<string, unknown>;
  if (database.stats_reset) database.stats_reset = new Date(String(database.stats_reset)).toISOString();
  else delete database.stats_reset;
  const tableCount = (db.prepare("SELECT COUNT(*) n FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r'").get() as { n: number }).n;
  const tables = db
    .prepare(
      `SELECT n.nspname "schema", c.relname "name", pg_total_relation_size(c.oid) total_bytes, pg_relation_size(c.oid) table_bytes,
              pg_indexes_size(c.oid) index_bytes, COALESCE(s.n_live_tup, 0) "rows", COALESCE(s.n_dead_tup, 0) dead_rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
       WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
       ORDER BY pg_total_relation_size(c.oid) DESC, c.relname LIMIT 20`,
    )
    .all();
  const full = !!(db.prepare("SELECT pg_has_role(current_user, 'pg_read_all_stats', 'member') OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) ok").get() as { ok: boolean }).ok;
  const operations = (
    db
      .prepare(
        `SELECT pid, COALESCE(datname, '') database, COALESCE(usename, '') "user", COALESCE(application_name, '') application,
                COALESCE(host(client_addr), '') client, COALESCE(backend_type, '') backend_type, COALESCE(state, '') state,
                COALESCE(wait_event_type, '') wait_event_type, COALESCE(wait_event, '') wait_event,
                COALESCE(xact_start, query_start)::text started,
                COALESCE(EXTRACT(EPOCH FROM (now() - COALESCE(xact_start, query_start))) * 1000, 0)::bigint duration_ms,
                left(COALESCE(query, ''), 1000) query, length(COALESCE(query, '')) > 1000 truncated
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND state IS NOT NULL AND state <> 'idle'
         ORDER BY COALESCE(xact_start, query_start) NULLS LAST LIMIT 10`,
      )
      .all() as Record<string, unknown>[]
  ).map((o) => ({ ...o, started: o.started ? new Date(String(o.started)).toISOString() : undefined }));
  return { collected_at: new Date().toISOString(), full_visibility: full, database, table_count: tableCount, tables, operations, statements: statements(db) };
}

function statements(db: DB) {
  const installed = db.prepare("SELECT n.nspname s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements'").get() as
    | { s: string }
    | undefined;
  if (!installed) return { installed: false, by_total: null, by_mean: null };
  const top = (order: string) =>
    db
      .prepare(
        `SELECT queryid::text query_id, left(query, 1000) query, calls, round(total_exec_time::numeric, 2) total_ms, round(mean_exec_time::numeric, 2) mean_ms, "rows"
         FROM ${q(installed.s)}.pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
         ORDER BY ${order} DESC LIMIT 10`,
      )
      .all();
  try {
    return { installed: true, by_total: top('total_exec_time'), by_mean: top('mean_exec_time') };
  } catch (e) {
    return { installed: true, error: (e as Error).message, by_total: null, by_mean: null };
  }
}

export function targetUrl(t: PostgresTarget) {
  return postgresUrl(t, t.password);
}

/** Connects to another database and reports whether Inventory DB can move there. */
export async function probePostgres(t: PostgresTarget) {
  const client = new pg.Client({ connectionString: targetUrl(t), connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  try {
    await client.connect();
    if (t.schema) await client.query(`SET search_path TO ${q(t.schema)}`);
    const { rows } = await client.query(
      `SELECT current_setting('server_version') version, current_setting('server_version_num')::int num, current_database() database,
              current_user "user", current_schema() "schema",
              CASE WHEN current_schema() IS NULL THEN has_database_privilege(current_database(), 'CREATE')
                   ELSE has_schema_privilege(current_schema(), 'CREATE') END can_create,
              to_regclass('nc_migrations') IS NOT NULL has_state`,
    );
    const r = rows[0];
    let savedAt: string | undefined;
    if (r.has_state) savedAt = ((await client.query('SELECT MAX(applied_at) at FROM nc_migrations')).rows[0]?.at as string) ?? undefined;
    const probe = { version: r.version, database: r.database, user: r.user, schema: r.schema, can_create: !!r.can_create, has_state: !!r.has_state, saved_at: savedAt };
    if (r.num < MIN_VERSION) return { ok: false, error: `PostgreSQL ${r.version} is too old: version 14 or newer is required`, probe };
    return { ok: true, probe };
  } catch (e) {
    return { ok: false, error: (e as Error).message, probe: null };
  } finally {
    await client.end().catch(() => {});
  }
}

const sameTarget = (a: DB, url: string, schema?: string) => {
  const x = parsePostgresUrl(a.target.url).connection;
  const y = parsePostgresUrl(url).connection;
  const host = (h: string) => (h === '127.0.0.1' || h === '::1' ? 'localhost' : h.toLowerCase());
  return host(x.host) === host(y.host) && x.port === y.port && x.database === y.database && (a.target.schema ?? 'public') === (schema ?? 'public');
};

interface Column {
  attname: string;
  type: string;
  attnotnull: boolean;
  def: string | null;
  attidentity: string;
  attgenerated: string;
}

/**
 * Copies every table (with data, constraints, indexes and identity counters) and every function of the source
 * schema into the target in one transaction. Runs synchronously: no request can change data during the copy.
 */
export function copyDatabase(source: DB, target: DB, opts: { overwrite: boolean }): { tables: number; rows: number } {
  const src = (sql: string, params?: unknown[]) => source.conn.query(sql, params).rows as any[];
  const dst = (sql: string, params?: unknown[]) => target.conn.query(sql, params).rows as any[];
  const srcSchema = src('SELECT current_schema() s')[0].s as string;
  const tables = src("SELECT oid::int oid, relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r' ORDER BY relname") as {
    oid: number;
    relname: string;
  }[];
  const functions = src(
    "SELECT p.proname, pg_get_functiondef(p.oid) def FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace AND p.prokind = 'f' ORDER BY p.oid",
  ) as { proname: string; def: string }[];
  const unqualify = (sql: string) => sql.split(`${q(srcSchema)}.`).join('').split(`${srcSchema}.`).join('');

  dst('BEGIN');
  try {
    dst('SET LOCAL check_function_bodies = false');
    const hasState = dst("SELECT to_regclass('nc_migrations') IS NOT NULL x")[0].x;
    if (hasState && !opts.overwrite) throw new HttpError(409, 'POSTGRES_HAS_STATE', 'The database already holds Inventory DB data');
    for (const t of tables) dst(`DROP TABLE IF EXISTS ${q(t.relname)} CASCADE`);
    for (const f of functions) dst(`DROP FUNCTION IF EXISTS ${q(f.proname)} CASCADE`);
    for (const f of functions) dst(unqualify(f.def).replace(/^CREATE OR REPLACE FUNCTION\s+("[^"]+"|[^\s.(]+)\./, 'CREATE OR REPLACE FUNCTION '));

    const later: string[] = [];
    let rows = 0;
    for (const t of tables) {
      const cols = src(
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod) "type", a.attnotnull, pg_get_expr(d.adbin, d.adrelid) def, a.attidentity::text attidentity, a.attgenerated::text attgenerated
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [t.oid],
      ) as Column[];
      const defs = cols.map((c) => {
        let s = `${q(c.attname)} ${c.type}`;
        if (c.attidentity === 'a') s += ' GENERATED ALWAYS AS IDENTITY';
        else if (c.attidentity === 'd') s += ' GENERATED BY DEFAULT AS IDENTITY';
        else if (c.attgenerated === 's' && c.def) s += ` GENERATED ALWAYS AS (${unqualify(c.def)}) STORED`;
        else if (c.def) s += ` DEFAULT ${unqualify(c.def)}`;
        if (c.attnotnull) s += ' NOT NULL';
        return s;
      });
      const constraints = src('SELECT conname, contype::text contype, pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid = $1 ORDER BY contype DESC, conname', [t.oid]) as {
        conname: string;
        contype: string;
        def: string;
      }[];
      for (const c of constraints) {
        const sql = `CONSTRAINT ${q(c.conname)} ${unqualify(c.def)}`;
        if (c.contype === 'f') later.push(`ALTER TABLE ${q(t.relname)} ADD ${sql}`);
        else if (c.contype === 'p' || c.contype === 'u' || c.contype === 'c') defs.push(sql);
      }
      dst(`CREATE TABLE ${q(t.relname)} (${defs.join(', ')})`);
      const indexes = src('SELECT pg_get_indexdef(indexrelid) def FROM pg_index WHERE indrelid = $1 AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE conrelid = $1)', [t.oid]) as {
        def: string;
      }[];
      for (const i of indexes) later.push(unqualify(i.def));

      // Data, in batches that stay under PostgreSQL's 65535 parameters per statement.
      const copied = cols.filter((c) => c.attgenerated !== 's');
      const names = copied.map((c) => q(c.attname)).join(', ');
      const batch = Math.max(1, Math.floor(30_000 / Math.max(1, copied.length)));
      const identity = copied.some((c) => c.attidentity === 'a') ? ' OVERRIDING SYSTEM VALUE' : '';
      for (let offset = 0; ; offset += batch) {
        const data = src(`SELECT ${names} FROM ${q(t.relname)} ORDER BY ctid LIMIT ${batch} OFFSET ${offset}`);
        if (!data.length) break;
        const params: unknown[] = [];
        const value = (c: Column, v: unknown) => (v !== null && /^jsonb?$/.test(c.type) ? JSON.stringify(v) : v);
        const tuples = data.map((r) => `(${copied.map((c) => (params.push(value(c, r[c.attname])), `$${params.length}`)).join(', ')})`);
        dst(`INSERT INTO ${q(t.relname)} (${names})${identity} VALUES ${tuples.join(', ')}`, params);
        rows += data.length;
        if (data.length < batch) break;
      }
      for (const c of copied.filter((x) => x.attidentity))
        dst(`SELECT setval(pg_get_serial_sequence($1, $2), (SELECT COALESCE(MAX(${q(c.attname)}), 0) + 1 FROM ${q(t.relname)}), false)`, [q(t.relname), c.attname]);
    }
    for (const sql of later) dst(sql);
    for (const t of tables) {
      const a = Number(src(`SELECT COUNT(*) n FROM ${q(t.relname)}`)[0].n);
      const b = Number(dst(`SELECT COUNT(*) n FROM ${q(t.relname)}`)[0].n);
      if (a !== b) throw new Error(`Table ${t.relname}: ${a} rows in the source, ${b} copied`);
    }
    dst('COMMIT');
    return { tables: tables.length, rows };
  } catch (e) {
    try {
      dst('ROLLBACK');
    } catch {
      /* keep the original error */
    }
    throw e;
  }
}

/** Copies the data to `t`, saves the new connection (password in OpenBao) and switches the app to it. */
export async function migratePostgres(t: PostgresTarget, overwrite: boolean, userEmail?: string) {
  const url = targetUrl(t);
  const source = getDb();
  if (sameTarget(source, url, t.schema)) throw new HttpError(409, 'POSTGRES_SAME_DATABASE', 'This is the database Inventory DB already uses');
  const probe = await probePostgres(t);
  if (!probe.ok || !probe.probe) throw new HttpError(400, 'POSTGRES_UNREACHABLE', probe.error ?? 'The database does not answer');
  if (!probe.probe.can_create && !probe.probe.has_state) throw new HttpError(400, 'POSTGRES_NO_CREATE', 'The user may not create tables in that database');
  let target: DB | null = null;
  try {
    target = connectDb(url, { schema: t.schema, connectTimeoutMs: 15_000 });
    const copied = copyDatabase(source, target, { overwrite });
    target.close();
    target = null;
    // Persist before switching so a restart lands on the new database too.
    const { password, schema: _schema, ...connection } = t;
    if (secretBackend() === 'openbao') {
      await setSecret(PG_PASSWORD_SECRET, { password });
      writeConfig({ postgres: { ...connection, password_in: 'openbao' } });
    } else writeConfig({ postgres: { ...connection, password_in: 'file', password } });
    configureDatabase(url);
    const next = openDb(url, { schema: t.schema });
    setDb(next);
    source.close();
    logEvent('warn', 'Inventory DB moved to another PostgreSQL database', { to: where(connection), by: userEmail, tables: copied.tables, rows: copied.rows });
    return { where: where(connection), ...copied };
  } catch (e) {
    target?.close();
    if (e instanceof HttpError) throw e;
    logEvent('error', 'Moving to another PostgreSQL database failed', { error: (e as Error).message });
    throw new HttpError(500, 'POSTGRES_MIGRATION_FAILED', `The data was not moved: ${(e as Error).message}`);
  }
}
