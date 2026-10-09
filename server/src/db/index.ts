import { randomBytes } from 'node:crypto';
import { migrations } from './migrations.js';
import { PgSync } from './pgsync.js';

export type { PgError } from './pgsync.js';

export interface RunResult {
  changes: number;
}

export interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}

/**
 * Placeholders: `?` (positional) or `@name` (taken from a single object argument) are rewritten to `$n`.
 * String literals, quoted identifiers and comments are skipped.
 */
interface Compiled {
  text: string;
  names: string[] | null;
}

function compile(sql: string): Compiled {
  let out = '';
  let n = 0;
  const names: string[] = [];
  let named = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      out += sql.slice(i, j + 1);
      i = j;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j < 0 ? sql.length : j;
      out += sql.slice(i, end);
      i = end - 1;
    } else if (c === '?') {
      // `x IS ?` / `x IS NOT ?` are null-safe comparisons.
      const is = /\bIS(\s+NOT)?\s+$/i.exec(out);
      if (is) out = out.slice(0, is.index) + (is[1] ? 'IS DISTINCT FROM ' : 'IS NOT DISTINCT FROM ');
      out += `$${++n}`;
    } else if (c === '@' && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))!;
      named = true;
      let k = names.indexOf(m[0]);
      if (k < 0) k = names.push(m[0]) - 1;
      out += `$${k + 1}`;
      i += m[0].length;
    } else out += c;
  }
  if (named && n) throw new Error('Mixing ? and @name placeholders is not supported');
  return { text: out, names: named ? names : null };
}

/** Normalises JS values the way the code base passes them (booleans as 1/0, like the stored INTEGER flags). */
function bind(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return v.toString();
  return v;
}

/**
 * Thin synchronous facade over one PostgreSQL connection with the small API surface the code base uses:
 * `prepare(sql).get/all/run`, `exec` and nested `transaction` (savepoints).
 */
export class DB {
  private cache = new Map<string, Compiled>();
  private depth = 0;

  constructor(
    readonly conn: PgSync,
    /** Where this connection points (shown on the settings pages; the password is part of the URL). */
    readonly target: { url: string; schema?: string } = { url: '' },
  ) {}

  prepare(sql: string): Statement {
    let c = this.cache.get(sql);
    if (!c) {
      c = compile(sql);
      if (this.cache.size > 2000) this.cache.clear();
      this.cache.set(sql, c);
    }
    const compiled = c;
    const exec = (params: unknown[]) => {
      let values: unknown[];
      if (compiled.names) {
        const obj = (params[0] ?? {}) as Record<string, unknown>;
        values = compiled.names.map((k) => bind(obj[k]));
      } else values = params.map(bind);
      return this.conn.query(compiled.text, values);
    };
    return {
      get: (...p) => exec(p).rows[0],
      all: (...p) => exec(p).rows,
      run: (...p) => ({ changes: exec(p).rowCount }),
    };
  }

  /** Runs one or more statements without parameters. */
  exec(sql: string): void {
    this.conn.query(sql);
  }

  /** Wraps `fn` in a transaction; nested calls use savepoints. `fn` must be synchronous. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A) => {
      const level = this.depth;
      this.conn.query(level === 0 ? 'BEGIN' : `SAVEPOINT sp${level}`);
      this.depth++;
      try {
        const result = fn(...args);
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Transaction function must be synchronous');
        this.conn.query(level === 0 ? 'COMMIT' : `RELEASE SAVEPOINT sp${level}`);
        return result;
      } catch (e) {
        try {
          this.conn.query(level === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT sp${level}`);
        } catch {
          /* keep the original error */
        }
        throw e;
      } finally {
        this.depth = level;
      }
    };
  }

  close() {
    this.conn.close();
  }
}

let db: DB | null = null;

export const DEFAULT_DATABASE_URL = 'postgres://inventory:inventory@localhost:5432/inventory';

let configuredUrl: string | null = null;

/** The database URL from the settings (config file); takes precedence over `DATABASE_URL`. */
export function configureDatabase(url: string | null) {
  configuredUrl = url;
}

/** Opens (or returns) the app database configured by the settings or `DATABASE_URL`. */
export function getDb(): DB {
  if (!db) db = openDb(configuredUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  return db;
}

/** Connects and applies pending migrations. `schema` isolates a database inside its own schema (tests). */
export function openDb(connectionString: string, opts: { schema?: string } = {}): DB {
  const conn = new DB(new PgSync({ connectionString, schema: opts.schema }), { url: connectionString, schema: opts.schema });
  migrate(conn);
  return conn;
}

/** Connects without migrating (copying a database: the migration ledger comes with the data). */
export function connectDb(connectionString: string, opts: { schema?: string; connectTimeoutMs?: number } = {}): DB {
  return new DB(new PgSync({ connectionString, schema: opts.schema, connectTimeoutMs: opts.connectTimeoutMs }), { url: connectionString, schema: opts.schema });
}

/** Replace the shared connection (tests). */
export function setDb(conn: DB | null) {
  db = conn;
}

function migrate(conn: DB) {
  // Serialise concurrent starts (several replicas, parallel test files sharing a schema).
  conn.transaction(() => {
    conn.exec('SELECT pg_advisory_xact_lock(724113)');
    conn.exec('CREATE TABLE IF NOT EXISTS nc_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set((conn.prepare('SELECT id FROM nc_migrations').all() as { id: number }[]).map((r) => r.id));
    for (const [i, sql] of migrations.entries()) {
      if (applied.has(i)) continue;
      conn.exec(sql);
      conn.prepare('INSERT INTO nc_migrations (id, applied_at) VALUES (?, ?)').run(i, now());
    }
  })();
}

/** Moves a table's `id` sequence past its largest id, after rows were inserted with explicit ids. */
export function syncIdSequence(table: string, conn: DB = getDb()) {
  conn.prepare(`SELECT setval(pg_get_serial_sequence(?, 'id'), (SELECT COALESCE(MAX(id), 0) + 1 FROM ${q(table)}), false)`).get(q(table));
}

/** Short random id with a type prefix, e.g. `tbl_x8k2...`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url').replace(/[-_]/g, '').slice(0, 12).toLowerCase()}`;
}

export const now = () => new Date().toISOString();

/** Quote an SQL identifier. All physical names are generated, but quote anyway. */
export const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** Physical names for user data. */
export const dataTableName = (tableId: string) => `t_${tableId}`;
export const dataColumnName = (columnId: string) => `c_${columnId}`;
export const linkTableName = (columnId: string) => `l_${columnId}`;

export function json<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
