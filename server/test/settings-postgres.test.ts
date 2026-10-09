/** PostgreSQL settings: overview, statistics, checking another database and moving all data there. */
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Base, Table } from '../../shared/src/index.js';
import { getDb } from '../src/db/index.js';
import { parsePostgresUrl } from '../src/system/config.js';
import { TEST_DATABASE_URL, TEST_SCHEMA_PREFIX } from './db-env.js';
import { createTestApp, signUpUser } from './helpers.js';

process.env.CONFIG_DIR = mkdtempSync(join(tmpdir(), 'idb-config-'));

let app: FastifyInstance;
let admin: Record<string, string>;

async function api<T = any>(method: string, url: string, payload?: unknown, status = 200): Promise<T> {
  const res = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: admin, payload: payload as object });
  if (res.statusCode !== status) throw new Error(`${method} ${url} -> ${res.statusCode} (expected ${status}): ${res.body}`);
  return res.json() as T;
}

const { connection, password } = parsePostgresUrl(TEST_DATABASE_URL);
const target = (schema: string) => ({ ...connection, password, schema });

beforeAll(async () => {
  app = await createTestApp();
  admin = (await signUpUser(app)).headers;
  await api('GET', '/settings/postgres');
});

describe('PostgreSQL settings', () => {
  it('shows the current connection without the password, and answers a test', async () => {
    const view = await api('GET', '/settings/postgres');
    expect(view).toMatchObject({ ok: true, source: 'environment', connection: { host: connection.host, database: connection.database, user: connection.user } });
    expect(JSON.stringify(view)).not.toContain(`:${password}@`);
    expect(view.info.version).toMatch(/^PostgreSQL \d+/);
    const test = await api('POST', '/settings/postgres/test');
    expect(test).toMatchObject({ ok: true });
  });

  it('collects statistics: counters, table sizes, operations and pg_stat_statements', async () => {
    const stats = await api('GET', '/settings/postgres/stats');
    expect(stats.database.xact_commit).toBeGreaterThan(0);
    expect(stats.table_count).toBeGreaterThan(10);
    expect(stats.tables[0]).toMatchObject({ name: expect.any(String), total_bytes: expect.any(Number) });
    expect(Array.isArray(stats.operations)).toBe(true);
    expect(typeof stats.statements.installed).toBe('boolean');
  });

  it('checks another database', async () => {
    const probe = await api('POST', '/settings/postgres/probe', target(`${TEST_SCHEMA_PREFIX}probe_${randomBytes(3).toString('hex')}`));
    expect(probe).toMatchObject({ ok: true, probe: { can_create: true, has_state: false } });
    const wrong = await api('POST', '/settings/postgres/probe', { ...target('x'), password: 'definitely-wrong', host: '127.0.0.1', port: 1 });
    expect(wrong.ok).toBe(false);
  });

  it('refuses to move onto the database already in use', async () => {
    await api('POST', '/settings/postgres/migrate', { target: target(getDb().target.schema!) }, 409);
  });

  it('copies all data to another database and keeps working there', async () => {
    const base = await api<Base>('POST', '/bases', { title: 'Before move' });
    const table = await api<Table>('POST', `/bases/${base.id}/tables`, { title: 'Things', columns: [{ title: 'Name', type: 'SingleLineText' }] });
    await api('POST', `/tables/${table.id}/records`, [{ Name: 'one' }, { Name: 'two' }]);
    const site = await api('POST', '/dcim/sites', { name: 'HQ', slug: 'hq' }, 201);
    const old = getDb();
    const schema = `${TEST_SCHEMA_PREFIX}moved_${randomBytes(3).toString('hex')}`;

    const done = await api('POST', '/settings/postgres/migrate', { target: target(schema) });
    expect(done.tables).toBeGreaterThan(10);
    expect(getDb()).not.toBe(old);
    expect(getDb().target.schema).toBe(schema);

    // Same data, ids continue, links and NetBox objects intact.
    const records = await api('GET', `/tables/${table.id}/records`);
    const name = table.columns.find((c) => c.title === 'Name')!.id;
    expect(records.list.map((r: Record<string, unknown>) => r[name])).toEqual(['one', 'two']);
    const next = await api('POST', `/tables/${table.id}/records`, { Name: 'three' });
    expect(next.id).toBe(3);
    expect((await api('GET', `/dcim/sites/${site.id}`)).name).toBe('HQ');
    expect((await api('POST', '/dcim/sites', { name: 'DC2', slug: 'dc2' }, 201)).id).toBe(site.id + 1);
    // The formula helpers came along.
    expect(getDb().prepare("SELECT nc_num(' 42abc') n").get()).toEqual({ n: 42 });

    const file = JSON.parse(readFileSync(join(process.env.CONFIG_DIR!, 'inventory.json'), 'utf8'));
    expect(file.postgres).toMatchObject({ host: connection.host, database: connection.database, password_in: 'file' });
    expect((await api('GET', '/settings/postgres')).source).toBe('settings');

    // A second move onto a database that already has the data needs the overwrite switch.
    const back = target(schema.replace('moved', 'again'));
    await api('POST', '/settings/postgres/migrate', { target: back });
    await api('POST', '/settings/postgres/migrate', { target: target(schema) }, 409);
  });
});
