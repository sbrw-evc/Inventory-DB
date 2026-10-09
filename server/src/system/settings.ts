/** Application settings kept in the database (`nc_settings`): directory sign-in, password policy. Never secrets. */
import { getDb, json, now } from '../db/index.js';

export function readSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM nc_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? json<T>(row.value, fallback) : fallback;
}

export function writeSetting(key: string, value: unknown, userId?: string | null) {
  getDb()
    .prepare(
      `INSERT INTO nc_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(key, JSON.stringify(value), now(), userId ?? null);
}

export function settingUpdatedAt(key: string): string | null {
  const row = getDb().prepare('SELECT updated_at FROM nc_settings WHERE key = ?').get(key) as { updated_at: string } | undefined;
  return row?.updated_at ?? null;
}
