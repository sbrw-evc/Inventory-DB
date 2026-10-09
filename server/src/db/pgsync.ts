/**
 * Synchronous PostgreSQL access.
 *
 * The app's data layer (meta service, record engine, NetBox engine) is written as plain synchronous code that runs
 * a whole request inside one transaction. To keep that model, queries are executed by a `pg` client living in a
 * worker thread while the calling thread blocks on `Atomics.wait` until the result arrives. There is exactly one
 * connection per `PgSync`, and because the caller is blocked for the duration of each statement, statements and
 * transactions can never interleave — the same guarantees the code relied on with an embedded database.
 */
import { createRequire } from 'node:module';
import { MessageChannel, type MessagePort, Worker, receiveMessageOnPort } from 'node:worker_threads';

export interface PgError extends Error {
  code?: string;
  detail?: string;
  constraint?: string;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

type Reply = { ok: true; rows: Record<string, unknown>[]; rowCount: number } | { ok: false; error: { message: string; code?: string; detail?: string; constraint?: string } };

// Runs in the worker (CommonJS, eval'd). Kept as plain JS so it works the same from `src` (tsx/vitest) and `dist`.
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const pg = require(workerData.pgPath);
const { port, flag, connectionString, schema } = workerData;
const signal = new Int32Array(flag);

// Return numbers, not strings, for COUNT/SUM results; keep date/time values as text (the app stores ISO text).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
for (const oid of [1082, 1083, 1114, 1184, 1266]) pg.types.setTypeParser(oid, (v) => v);

let client = null;
// A connection lost inside a transaction must not let later statements run (and "commit") on a new one.
let inTx = false;
let txLost = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open() {
  const c = new pg.Client({ connectionString });
  const drop = () => {
    if (client !== c) return;
    client = null;
    if (inTx) txLost = true;
  };
  c.on('error', drop);
  c.on('end', drop);
  await c.connect();
  try {
    // Date arithmetic (formulas, filters) is done in UTC, like the ISO timestamps the app stores.
    await c.query("SET TIME ZONE 'UTC'");
    if (schema) {
      const ident = '"' + schema.replace(/"/g, '""') + '"';
      await c.query('CREATE SCHEMA IF NOT EXISTS ' + ident);
      await c.query('SET search_path TO ' + ident);
    }
  } catch (e) {
    c.end().catch(() => {});
    throw e;
  }
  client = c;
}

/** Connects if needed; keeps retrying until \`deadline\` (the database may still be starting). */
async function connected(deadline) {
  while (!client) {
    try {
      await open();
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      await sleep(500);
    }
  }
  return client;
}

function reply(msg) {
  port.postMessage(msg);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}

port.on('message', async (req) => {
  try {
    if (req.op === 'connect') {
      await connected(Date.now() + req.retryMs);
      reply({ ok: true, rows: [], rowCount: 0 });
      return;
    }
    if (req.op === 'close') {
      if (client) await client.end();
      reply({ ok: true, rows: [], rowCount: 0 });
      return;
    }
    const verb = req.params ? '' : req.sql.trim().toUpperCase();
    if (txLost) {
      if (verb === 'ROLLBACK') {
        inTx = txLost = false;
        reply({ ok: true, rows: [], rowCount: 0 });
      } else reply({ ok: false, error: { message: 'Database connection was lost during the transaction', code: '08006' } });
      return;
    }
    const c = await connected(Date.now());
    const res = req.params ? await c.query({ text: req.sql, values: req.params }) : await c.query(req.sql);
    if (verb === 'BEGIN') inTx = true;
    else if (verb === 'COMMIT' || verb === 'ROLLBACK') inTx = false;
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    reply({ ok: true, rows: (last && last.rows) || [], rowCount: (last && last.rowCount) || 0 });
  } catch (e) {
    reply({ ok: false, error: { message: e && e.message ? e.message : String(e), code: e && e.code, detail: e && e.detail, constraint: e && e.constraint } });
  }
});
`;

export interface PgSyncOptions {
  connectionString: string;
  /** Create (if needed) and use this schema instead of the connection's default search_path. */
  schema?: string;
  /** Per-statement wait limit in ms (0 = none). */
  timeoutMs?: number;
  /** How long to keep trying the initial connection (ms); the database may still be starting. */
  connectTimeoutMs?: number;
}

export class PgSync {
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly signal: Int32Array;
  private readonly timeoutMs: number;
  private closed = false;

  constructor(opts: PgSyncOptions) {
    const require = createRequire(import.meta.url);
    const flag = new SharedArrayBuffer(4);
    const { port1, port2 } = new MessageChannel();
    this.signal = new Int32Array(flag);
    this.port = port1;
    this.timeoutMs = opts.timeoutMs ?? 0;
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pgPath: require.resolve('pg'), port: port2, flag, connectionString: opts.connectionString, schema: opts.schema ?? null },
      transferList: [port2],
    });
    // Neither the worker nor the port may keep the process alive on their own.
    this.worker.unref();
    this.port.unref();
    const connectTimeoutMs = opts.connectTimeoutMs ?? 30000;
    this.call({ op: 'connect', retryMs: Math.max(0, connectTimeoutMs - 5000) }, connectTimeoutMs);
  }

  /** Runs a statement. Without `params`, the simple protocol is used and `sql` may hold several statements. */
  query(sql: string, params?: unknown[]): QueryResult {
    return this.call({ op: 'query', sql, params });
  }

  close() {
    if (this.closed) return;
    try {
      this.call({ op: 'close' });
    } finally {
      this.closed = true;
      void this.worker.terminate();
    }
  }

  private call(req: { op: string; sql?: string; params?: unknown[]; retryMs?: number }, timeoutMs = this.timeoutMs): QueryResult {
    if (this.closed) throw new Error('Database connection is closed');
    Atomics.store(this.signal, 0, 0);
    this.port.postMessage(req);
    const waited = Atomics.wait(this.signal, 0, 0, timeoutMs > 0 ? timeoutMs : undefined);
    if (waited === 'timed-out') {
      this.closed = true;
      void this.worker.terminate();
      throw new Error(`Database did not answer within ${timeoutMs} ms`);
    }
    const msg = receiveMessageOnPort(this.port)?.message as Reply | undefined;
    if (!msg) throw new Error('Database worker returned no result');
    if (!msg.ok) {
      const err = new Error(msg.error.message) as PgError;
      err.code = msg.error.code;
      err.detail = msg.error.detail;
      err.constraint = msg.error.constraint;
      throw err;
    }
    return { rows: msg.rows, rowCount: msg.rowCount };
  }
}
