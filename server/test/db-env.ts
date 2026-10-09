import { DEFAULT_DATABASE_URL } from '../src/db/index.js';

/** PostgreSQL database the tests use; every test file creates (and global-setup drops) its own `test_*` schema. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
/** Schemas created by tests start with this; global-setup.ts drops them. */
export const TEST_SCHEMA_PREFIX = 'test_';
