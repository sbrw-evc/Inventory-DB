import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './migrations.js';

export type DB = Database.Database;

let db: DB | null = null;

/** Opens (or returns) the app database. `DB_PATH=:memory:` is used by tests. */
export function getDb(): DB {
  if (!db) db = openDb(process.env.DB_PATH ?? 'data/inventory.db');
  return db;
}

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const conn = new Database(path);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  migrate(conn);
  return conn;
}

/** Replace the shared connection (tests). */
export function setDb(conn: DB | null) {
  db = conn;
}

function migrate(conn: DB) {
  conn.exec('CREATE TABLE IF NOT EXISTS nc_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (conn.prepare('SELECT id FROM nc_migrations').all() as { id: number }[]).map((r) => r.id),
  );
  for (const [i, sql] of migrations.entries()) {
    if (applied.has(i)) continue;
    conn.transaction(() => {
      conn.exec(sql);
      conn.prepare('INSERT INTO nc_migrations (id, applied_at) VALUES (?, ?)').run(i, now());
    })();
  }
}

/** Short random id with a type prefix, e.g. `tbl_x8k2...`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url').replace(/[-_]/g, '').slice(0, 12).toLowerCase()}`;
}

export const now = () => new Date().toISOString();

/** Quote an SQLite identifier. All physical names are generated, but quote anyway. */
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
