import pg from 'pg';
import { TEST_DATABASE_URL, TEST_SCHEMA_PREFIX } from './db-env.js';

/** Drops the per-file schemas tests create, before and after a run. */
async function dropTestSchemas() {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>('SELECT nspname AS name FROM pg_namespace WHERE starts_with(nspname, $1)', [TEST_SCHEMA_PREFIX]);
    for (const { name } of rows) await client.query(`DROP SCHEMA "${name}" CASCADE`);
  } finally {
    await client.end();
  }
}

export async function setup() {
  await dropTestSchemas();
}

export async function teardown() {
  await dropTestSchemas();
}
