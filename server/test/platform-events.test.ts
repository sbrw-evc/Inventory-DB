import { afterEach, describe, expect, it } from 'vitest';
import { bus } from '../src/events.js';
import { audit } from '../src/platform/audit.js';
import { matchesFilter } from '../src/platform/filterEval.js';
import { flushWebhooks } from '../src/platform/webhooks.js';
import { createTestApp, signUpUser } from './helpers.js';
import { addMember, seedBase, startReceiver } from './platform-fixtures.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await flushWebhooks();
  while (closers.length) await closers.pop()!();
});

async function setup() {
  const app = await createTestApp();
  // a second app instance must not double-register bus listeners
  await createTestApp();
  const owner = await signUpUser(app);
  const s = seedBase(owner.userId);
  return { app, owner, s };
}

describe('audit', () => {
  it('records insert/update/delete/link from the bus with diffs of changed fields only', async () => {
    const { app, owner, s } = await setup();
    const ctx = { baseId: s.baseId, tableId: s.tableId, userId: owner.userId };
    const name = s.col('Name');
    const qty = s.col('Qty');
    const updated = s.col('Updated');

    bus.emit('record.insert', ctx, [{ id: 1, [name]: 'Bolt', [qty]: 5, [updated]: 't1' }]);
    bus.emit('record.update', ctx, [
      { before: { id: 1, [name]: 'Bolt', [qty]: 5, [updated]: 't1' }, after: { id: 1, [name]: 'Bolt', [qty]: 7, [updated]: 't2' } },
    ]);
    // no user-visible change → no entry
    bus.emit('record.update', ctx, [{ before: { id: 1, [qty]: 7, [updated]: 't2' }, after: { id: 1, [qty]: 7, [updated]: 't3' } }]);
    bus.emit('record.link', { ...ctx, columnId: 'col_x', recordId: 1, linkedIds: [3, 4], unlink: false });
    bus.emit('record.delete', ctx, [{ id: 1, [name]: 'Bolt', [qty]: 7 }]);

    const res = await app.inject({ method: 'GET', url: `/api/v1/tables/${s.tableId}/records/1/audit`, headers: owner.headers });
    const entries = res.json();
    expect(entries.map((e: { action: string }) => e.action)).toEqual(['delete', 'link', 'update', 'insert']);
    expect(entries[2].details).toEqual({ [qty]: { from: 5, to: 7 } });
    expect(entries[3].details).toEqual({ [name]: 'Bolt', [qty]: 5 });
    expect(entries[1].details).toEqual({ columnId: 'col_x', ids: [3, 4] });
    expect(entries[0].userName).toBeTruthy();

    audit({ baseId: s.baseId, userId: owner.userId, action: 'meta', details: { renamed: true } });
    const base = await app.inject({ method: 'GET', url: `/api/v1/bases/${s.baseId}/audit?limit=2`, headers: owner.headers });
    const page = base.json();
    expect(page.pageInfo).toEqual({ totalRows: 5, offset: 0, limit: 2, isLastPage: false });
    expect(page.list[0].action).toBe('meta');

    const editor = await signUpUser(app);
    addMember(s.baseId, editor.userId, 'editor');
    const denied = await app.inject({ method: 'GET', url: `/api/v1/bases/${s.baseId}/audit`, headers: editor.headers });
    expect(denied.statusCode).toBe(403);
  });
});

describe('webhooks', () => {
  it('CRUD, fires asynchronously with NocoDB-style payloads, honours conditions and logs deliveries', async () => {
    const { app, owner, s } = await setup();
    const rx = await startReceiver();
    closers.push(rx.close);
    const name = s.col('Name');
    const qty = s.col('Qty');
    const hooksUrl = `/api/v1/tables/${s.tableId}/hooks`;

    const bad = await app.inject({ method: 'POST', url: hooksUrl, headers: owner.headers, payload: { title: 'x', event: 'after.insert', url: 'ftp://x' } });
    expect(bad.statusCode).toBe(400);

    const ins = (
      await app.inject({
        method: 'POST',
        url: hooksUrl,
        headers: owner.headers,
        payload: {
          title: 'Big inserts',
          event: 'after.insert',
          url: rx.url,
          headers: { 'x-secret': 's3' },
          condition: { logic: 'and', children: [{ columnId: qty, op: 'gte', value: 10 }] },
        },
      })
    ).json();
    expect(ins).toMatchObject({ title: 'Big inserts', method: 'POST', active: true, headers: { 'x-secret': 's3' } });
    const upd = (await app.inject({ method: 'POST', url: hooksUrl, headers: owner.headers, payload: { title: 'Updates', event: 'after.update', url: rx.url, method: 'PUT' } })).json();
    expect((await app.inject({ method: 'GET', url: hooksUrl, headers: owner.headers })).json()).toHaveLength(2);

    const ctx = { baseId: s.baseId, tableId: s.tableId, userId: owner.userId };
    bus.emit('record.insert', ctx, [
      { id: 1, [name]: 'Small', [qty]: 2 },
      { id: 2, [name]: 'Large', [qty]: 50 },
    ]);
    expect(rx.received).toHaveLength(0); // not delivered synchronously
    bus.emit('record.insert', ctx, [{ id: 3, [name]: 'Tiny', [qty]: 1 }]); // filtered out entirely
    bus.emit('record.update', ctx, [{ before: { id: 2, [name]: 'Large', [qty]: 50 }, after: { id: 2, [name]: 'Large', [qty]: 40 } }]);
    await flushWebhooks();

    expect(rx.received).toHaveLength(2);
    const insert = rx.received.find((r) => r.method === 'POST')!;
    expect(insert.headers['x-secret']).toBe('s3');
    expect(insert.headers['content-type']).toContain('application/json');
    expect(insert.body).toMatchObject({
      type: 'records.after.insert',
      id: expect.any(String),
      data: { table_id: s.tableId, table_name: 'Products', rows: [{ id: 2, Name: 'Large', Qty: 50 }] },
    });
    const update = rx.received.find((r) => r.method === 'PUT')!;
    expect(update.body).toMatchObject({
      type: 'records.after.update',
      data: { rows: [{ id: 2, Qty: 40 }], previous_rows: [{ id: 2, Qty: 50 }] },
    });

    const logs = (await app.inject({ method: 'GET', url: `/api/v1/hooks/${ins.id}/logs`, headers: owner.headers })).json();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: 200, error: null, response: 'ok from receiver', event: 'after.insert' });

    // deactivate → no more deliveries
    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/hooks/${upd.id}`, headers: owner.headers, payload: { active: false } });
    expect(patched.json()).toMatchObject({ active: false, method: 'PUT', title: 'Updates' });
    bus.emit('record.update', ctx, [{ before: { id: 2, [qty]: 40 }, after: { id: 2, [qty]: 41 } }]);
    await flushWebhooks();
    expect(rx.received).toHaveLength(2);

    // test endpoint sends a sample synchronously
    const test = await app.inject({ method: 'POST', url: `/api/v1/hooks/${ins.id}/test`, headers: owner.headers });
    expect(test.json()).toMatchObject({ status: 200, hookId: ins.id });
    expect(rx.received[2].body).toMatchObject({ type: 'records.after.insert', data: { rows: [{ id: 1, Name: 'Sample Name', Qty: 3 }] } });

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/hooks/${ins.id}`, headers: owner.headers });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/hooks/${ins.id}/logs`, headers: owner.headers })).statusCode).toBe(404);
  });

  it('logs failures (non-2xx and unreachable hosts) without throwing', async () => {
    const { app, owner, s } = await setup();
    const rx = await startReceiver(() => 500);
    closers.push(rx.close);
    const mk = async (url: string) =>
      (await app.inject({ method: 'POST', url: `/api/v1/tables/${s.tableId}/hooks`, headers: owner.headers, payload: { title: 'h', event: 'after.delete', url } })).json();
    const failing = await mk(rx.url);
    const dead = await mk('http://127.0.0.1:1/nothing');
    bus.emit('record.delete', { baseId: s.baseId, tableId: s.tableId }, [{ id: 9 }]);
    await flushWebhooks();
    const l1 = (await app.inject({ method: 'GET', url: `/api/v1/hooks/${failing.id}/logs`, headers: owner.headers })).json();
    expect(l1[0]).toMatchObject({ status: 500, error: 'HTTP 500' });
    const l2 = (await app.inject({ method: 'GET', url: `/api/v1/hooks/${dead.id}/logs`, headers: owner.headers })).json();
    expect(l2[0].status).toBeNull();
    expect(l2[0].error).toBeTruthy();
    expect(l2[0].payload).toMatchObject({ type: 'records.after.delete', data: { rows: [{ id: 9 }] } });
  });

  it('requires editor role', async () => {
    const { app, s } = await setup();
    const viewer = await signUpUser(app);
    addMember(s.baseId, viewer.userId, 'viewer');
    const res = await app.inject({ method: 'GET', url: `/api/v1/tables/${s.tableId}/hooks`, headers: viewer.headers });
    expect(res.statusCode).toBe(403);
  });
});

describe('filter evaluator', () => {
  const rec = { id: 1, a: 'Hello World', n: 5, sel: ['Red', 'Blue'], c: true, e: null, d: '2020-01-02' };
  const t = (op: string, columnId: string, value?: unknown) =>
    matchesFilter({ logic: 'and', children: [{ columnId, op: op as never, value }] }, rec);
  it('handles common ops', () => {
    expect(t('eq', 'a', 'hello world')).toBe(true);
    expect(t('neq', 'n', 5)).toBe(false);
    expect(t('like', 'a', 'world')).toBe(true);
    expect(t('nlike', 'a', 'xyz')).toBe(true);
    expect(t('gt', 'n', 4)).toBe(true);
    expect(t('lte', 'n', '4')).toBe(false);
    expect(t('gt', 'd', '2020-01-01')).toBe(true);
    expect(t('blank', 'e')).toBe(true);
    expect(t('notblank', 'a')).toBe(true);
    expect(t('checked', 'c')).toBe(true);
    expect(t('notchecked', 'missing')).toBe(true);
    expect(t('anyof', 'sel', ['Green', 'red'])).toBe(true);
    expect(t('allof', 'sel', 'Red,Blue')).toBe(true);
    expect(t('nallof', 'sel', ['Red', 'Green'])).toBe(true);
    expect(t('nanyof', 'sel', ['Green'])).toBe(true);
    expect(
      matchesFilter(
        {
          logic: 'or',
          children: [
            { columnId: 'n', op: 'gt', value: 100 },
            { logic: 'and', children: [{ columnId: 'c', op: 'checked' }, { columnId: 'a', op: 'like', value: 'hello' }] },
          ],
        },
        rec,
      ),
    ).toBe(true);
    expect(matchesFilter(null, rec)).toBe(true);
  });
});
