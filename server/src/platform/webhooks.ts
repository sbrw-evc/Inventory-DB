import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FieldType, FilterGroup, RecordData, Webhook, WebhookEvent, WebhookLog } from '../../../shared/src/index.js';
import { requireTableRole } from '../auth/plugin.js';
import { getDb, json, newId, now } from '../db/index.js';
import { bus, type RecordEventContext } from '../events.js';
import { notFound } from '../errors.js';
import { doc } from './docs.js';
import { matchesFilter } from './filterEval.js';
import { assertPublicUrl } from './netguard.js';

export const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 2000;
const LOGS_KEPT_PER_HOOK = 200;

interface HookRow {
  id: string;
  table_id: string;
  title: string;
  event: WebhookEvent;
  url: string;
  method: Webhook['method'];
  headers: string;
  active: number;
  condition: string | null;
  created_at: string;
}

const toHook = (r: HookRow): Webhook => ({
  id: r.id,
  tableId: r.table_id,
  title: r.title,
  event: r.event,
  url: r.url,
  method: r.method,
  headers: json<Record<string, string>>(r.headers, {}),
  active: !!r.active,
  condition: json<FilterGroup | null>(r.condition, null),
});

function getHookRow(id: string): HookRow {
  const row = getDb().prepare('SELECT * FROM nc_hooks WHERE id = ?').get(id) as HookRow | undefined;
  if (!row) throw notFound('Webhook');
  return row;
}

// ---------- payloads ----------

export interface WebhookPayload {
  type: string;
  id: string;
  data: { table_id: string; table_name: string; rows: Record<string, unknown>[]; previous_rows?: Record<string, unknown>[] };
}

interface ColumnInfo {
  id: string;
  title: string;
  type: FieldType;
}

function tableInfo(tableId: string): { title: string; columns: ColumnInfo[] } {
  const db = getDb();
  const t = db.prepare('SELECT title FROM nc_tables WHERE id = ?').get(tableId) as { title: string } | undefined;
  const columns = db.prepare('SELECT id, title, type FROM nc_columns WHERE table_id = ? ORDER BY "order"').all(tableId) as ColumnInfo[];
  return { title: t?.title ?? '', columns };
}

/** NocoDB-style rows: keyed by field title (plus `id`). */
function titled(rec: Record<string, unknown>, columns: ColumnInfo[]): Record<string, unknown> {
  const out: Record<string, unknown> = { id: rec.id };
  for (const c of columns) {
    if (c.type === 'ID') continue;
    if (c.id in rec) out[c.title] = rec[c.id];
  }
  return out;
}

export function buildPayload(
  event: WebhookEvent,
  tableId: string,
  rows: Record<string, unknown>[],
  previous?: Record<string, unknown>[],
): WebhookPayload {
  const info = tableInfo(tableId);
  const data: WebhookPayload['data'] = {
    table_id: tableId,
    table_name: info.title,
    rows: rows.map((r) => titled(r, info.columns)),
  };
  if (previous) data.previous_rows = previous.map((r) => titled(r, info.columns));
  return { type: `records.${event}`, id: randomUUID(), data };
}

// ---------- delivery ----------

const pending = new Set<Promise<unknown>>();

/** Resolves once all in-flight deliveries finish (tests, graceful shutdown). */
export async function flushWebhooks(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

function writeLog(hook: Webhook, event: WebhookEvent, payload: unknown, status: number | null, error: string | null, response: string | null): WebhookLog {
  const log: WebhookLog = { id: newId('hkl'), hookId: hook.id, event, status, error, payload, response, createdAt: now() };
  try {
    const db = getDb();
    db.prepare('INSERT INTO nc_hook_logs (id, hook_id, event, status, error, payload, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      log.id,
      hook.id,
      event,
      status,
      error,
      JSON.stringify(payload),
      response,
      log.createdAt,
    );
    db.prepare(
      `DELETE FROM nc_hook_logs WHERE hook_id = ? AND id NOT IN
       (SELECT id FROM nc_hook_logs WHERE hook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${LOGS_KEPT_PER_HOOK})`,
    ).run(hook.id, hook.id);
  } catch (err) {
    // The hook may have been deleted (FK) or the DB swapped out (tests) while delivering.
    console.error('webhook log failed', err);
  }
  return log;
}

/** Sends one payload and records the outcome in nc_hook_logs. Never throws. */
export async function deliver(hook: Webhook, event: WebhookEvent, payload: unknown): Promise<WebhookLog> {
  let status: number | null = null;
  let error: string | null = null;
  let response: string | null = null;
  try {
    await assertPublicUrl(hook.url);
    const res = await fetch(hook.url, {
      method: hook.method || 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Inventory-DB-Webhook/1.0', ...hook.headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      redirect: 'manual',
    });
    status = res.status;
    const body = await res.text();
    response = body.length > MAX_RESPONSE_CHARS ? `${body.slice(0, MAX_RESPONSE_CHARS)}…` : body;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    const e = err as Error & { cause?: { message?: string } };
    error = e.name === 'TimeoutError' ? `Timed out after ${WEBHOOK_TIMEOUT_MS / 1000}s` : e.cause?.message ?? e.message;
  }
  return writeLog(hook, event, payload, status, error, response);
}

function track(p: Promise<unknown>) {
  pending.add(p);
  p.finally(() => pending.delete(p));
}

function activeHooks(tableId: string, event: WebhookEvent): Webhook[] {
  return (getDb().prepare('SELECT * FROM nc_hooks WHERE table_id = ? AND event = ? AND active = 1').all(tableId, event) as HookRow[]).map(toHook);
}

/** Fire matching hooks for a record event without blocking the request. */
function fire(event: WebhookEvent, ctx: RecordEventContext, rows: RecordData[], previous?: RecordData[]) {
  let hooks: Webhook[];
  try {
    hooks = activeHooks(ctx.tableId, event);
  } catch (err) {
    console.error('webhook lookup failed', err);
    return;
  }
  if (!hooks.length) return;
  for (const hook of hooks) {
    const idx = rows.map((r, i) => (matchesFilter(hook.condition, r) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const payload = buildPayload(
      event,
      ctx.tableId,
      idx.map((i) => rows[i]),
      previous ? idx.map((i) => previous[i]) : undefined,
    );
    track(new Promise((r) => setImmediate(r)).then(() => deliver(hook, event, payload)));
  }
}

let registered = false;
/** Subscribes to record events once per process. */
export function initWebhooks() {
  if (registered) return;
  registered = true;
  bus.on('record.insert', (ctx, records) => fire('after.insert', ctx, records));
  bus.on('record.update', (ctx, changes) =>
    fire(
      'after.update',
      ctx,
      changes.map((c) => c.after),
      changes.map((c) => c.before),
    ),
  );
  bus.on('record.delete', (ctx, records) => fire('after.delete', ctx, records));
}

// ---------- sample payload ----------

function sampleValue(type: FieldType, title: string): unknown {
  switch (type) {
    case 'Number':
    case 'Rating':
    case 'Rollup':
      return 3;
    case 'Decimal':
    case 'Currency':
    case 'Percent':
      return 12.5;
    case 'Checkbox':
      return true;
    case 'Date':
      return now().slice(0, 10);
    case 'DateTime':
    case 'CreatedTime':
    case 'LastModifiedTime':
      return now();
    case 'Email':
      return 'someone@example.com';
    case 'URL':
      return 'https://example.com';
    case 'PhoneNumber':
      return '+1 555 0100';
    case 'MultiSelect':
    case 'Lookup':
      return ['Sample'];
    case 'Attachment':
      return [];
    case 'JSON':
      return { sample: true };
    case 'Links':
      return 1;
    case 'ID':
      return 1;
    default:
      return `Sample ${title}`;
  }
}

export function samplePayload(hook: Webhook): WebhookPayload {
  const info = tableInfo(hook.tableId);
  const row: Record<string, unknown> = { id: 1 };
  for (const c of info.columns) if (c.type !== 'ID') row[c.id] = sampleValue(c.type, c.title);
  const prev = hook.event === 'after.update' ? [{ ...row }] : undefined;
  return buildPayload(hook.event, hook.tableId, [row], prev);
}

// ---------- routes ----------

const filterGroup: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    id: z.string().optional(),
    logic: z.enum(['and', 'or']),
    children: z.array(z.union([filterGroup, z.object({ id: z.string().optional(), columnId: z.string(), op: z.string(), value: z.unknown().optional() })])),
  }),
) as z.ZodType<FilterGroup>;

const hookInput = z.object({
  title: z.string().trim().min(1).max(255),
  event: z.enum(['after.insert', 'after.update', 'after.delete']),
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs are allowed'),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z.record(z.string()).default({}),
  active: z.boolean().default(true),
  condition: filterGroup.nullable().optional(),
});

export async function webhookRoutes(app: FastifyInstance) {
  initWebhooks();

  app.get<{ Params: { tableId: string } }>('/api/v1/tables/:tableId/hooks', { schema: doc('Webhooks', 'List webhooks of a table') }, async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    return (getDb().prepare('SELECT * FROM nc_hooks WHERE table_id = ? ORDER BY created_at').all(req.params.tableId) as HookRow[]).map(toHook);
  });

  app.post<{ Params: { tableId: string } }>('/api/v1/tables/:tableId/hooks', { schema: doc('Webhooks', 'Create a webhook') }, async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    const body = hookInput.parse(req.body);
    const id = newId('hk');
    getDb()
      .prepare('INSERT INTO nc_hooks (id, table_id, title, event, url, method, headers, active, condition, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        req.params.tableId,
        body.title,
        body.event,
        body.url,
        body.method,
        JSON.stringify(body.headers),
        body.active ? 1 : 0,
        body.condition ? JSON.stringify(body.condition) : null,
        now(),
      );
    return toHook(getHookRow(id));
  });

  app.patch<{ Params: { hookId: string } }>('/api/v1/hooks/:hookId', { schema: doc('Webhooks', 'Update a webhook') }, async (req) => {
    const row = getHookRow(req.params.hookId);
    requireTableRole(req, row.table_id, 'editor');
    const patch = hookInput.partial().parse(req.body);
    const cur = toHook(row);
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Webhook;
    if ('condition' in patch) next.condition = patch.condition ?? null;
    getDb()
      .prepare('UPDATE nc_hooks SET title = ?, event = ?, url = ?, method = ?, headers = ?, active = ?, condition = ? WHERE id = ?')
      .run(next.title, next.event, next.url, next.method, JSON.stringify(next.headers), next.active ? 1 : 0, next.condition ? JSON.stringify(next.condition) : null, row.id);
    return toHook(getHookRow(row.id));
  });

  app.delete<{ Params: { hookId: string } }>('/api/v1/hooks/:hookId', { schema: doc('Webhooks', 'Delete a webhook') }, async (req) => {
    const row = getHookRow(req.params.hookId);
    requireTableRole(req, row.table_id, 'editor');
    getDb().prepare('DELETE FROM nc_hooks WHERE id = ?').run(row.id);
    return { ok: true };
  });

  app.post<{ Params: { hookId: string } }>('/api/v1/hooks/:hookId/test', { schema: doc('Webhooks', 'Send a sample payload now') }, async (req) => {
    const row = getHookRow(req.params.hookId);
    requireTableRole(req, row.table_id, 'editor');
    const hook = toHook(row);
    return deliver(hook, hook.event, samplePayload(hook));
  });

  app.get<{ Params: { hookId: string } }>('/api/v1/hooks/:hookId/logs', { schema: doc('Webhooks', 'Delivery log, newest first') }, async (req) => {
    const row = getHookRow(req.params.hookId);
    requireTableRole(req, row.table_id, 'editor');
    const rows = getDb()
      .prepare('SELECT * FROM nc_hook_logs WHERE hook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100')
      .all(row.id) as { id: string; hook_id: string; event: WebhookEvent; status: number | null; error: string | null; payload: string | null; response: string | null; created_at: string }[];
    return rows.map(
      (r): WebhookLog => ({
        id: r.id,
        hookId: r.hook_id,
        event: r.event,
        status: r.status,
        error: r.error,
        payload: json<unknown>(r.payload, null),
        response: r.response,
        createdAt: r.created_at,
      }),
    );
  });
}
