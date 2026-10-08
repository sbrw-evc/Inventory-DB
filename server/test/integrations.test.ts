import Fastify from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { injectDcimClient, setDcimClient, type DcimClient, type NetboxObject } from '../src/integrations/dcim.js';
import { sign, verifySignature } from '../src/integrations/secrets.js';
import { clearIdentityCache } from '../src/routes/integrations.js';
import { createTestApp, signUpUser } from './helpers.js';

/** A small NetBox-shaped inventory: one site, one rack, two cabled devices. */
const fixtures: Record<string, NetboxObject[]> = {
  'dcim/sites': [{ id: 1, name: 'DC1', slug: 'dc1', status: { value: 'active', label: 'Active' }, tags: [] }],
  'dcim/racks': [{ id: 10, name: 'R01', site: { id: 1, name: 'DC1' }, status: { value: 'active' } }],
  'dcim/devices': [
    {
      id: 100,
      name: 'App-01',
      status: { value: 'active', label: 'Active' },
      role: { id: 1, name: 'Server' },
      device_type: { model: 'R650', manufacturer: { name: 'Dell' } },
      site: { id: 1, name: 'DC1' },
      rack: { id: 10, name: 'R01' },
      primary_ip4: { id: 1, address: '10.0.0.5/24' },
      serial: 'SN100',
      tags: [{ name: 'prod', slug: 'prod' }],
      last_updated: '2026-10-01T10:00:00Z',
    },
    { id: 101, name: 'sw-01', status: { value: 'planned' }, site: { id: 1, name: 'DC1' } },
  ],
  'ipam/ip-addresses': [
    { id: 1, address: '10.0.0.5/24', dns_name: 'app-01.corp.example', assigned_object: { id: 7, device: { id: 100, name: 'App-01' } } },
    { id: 2, address: '10.0.0.6/24', assigned_object: { id: 8, device: { id: 100, name: 'App-01' } } },
  ],
  'dcim/cables': [
    { id: 5, a_terminations: [{ object: { device: { id: 100 } } }], b_terminations: [{ object: { device: { id: 101 } } }] },
  ],
};

const fakeDcim: DcimClient = { list: async <T>(path: string) => (fixtures[path] ?? []) as T[] };

async function setup() {
  const app = await createTestApp();
  const owner = await signUpUser(app);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/integrations',
    headers: owner.headers,
    payload: { kind: 'umbrella', title: 'Umbrella prod', inventoryUrl: 'https://inv.example' },
  });
  expect(created.statusCode).toBe(201);
  const { integration, secret } = created.json() as { integration: { id: string }; secret: string };
  return { app, owner, id: integration.id, secret };
}

function signed(secret: string, body: unknown, ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  return {
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-umbrella-timestamp': String(ts),
      'x-umbrella-signature': sign(secret, String(ts), raw),
    },
  };
}

beforeEach(() => {
  setDcimClient(fakeDcim);
  clearIdentityCache();
});
afterAll(() => setDcimClient(null));

describe('integrations: management', () => {
  it('creates, lists, updates and deletes; other users cannot see it', async () => {
    const { app, owner, id, secret } = await setup();
    expect(secret).toMatch(/^whsec_/);
    const list = await app.inject({ method: 'GET', url: '/api/v1/integrations', headers: owner.headers });
    expect(list.json()).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain(secret);

    const other = await signUpUser(app);
    expect((await app.inject({ method: 'GET', url: `/api/v1/integrations/${id}`, headers: other.headers })).statusCode).toBe(404);

    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/integrations/${id}`, headers: owner.headers, payload: { title: 'Renamed' } });
    expect(patched.json()).toMatchObject({ title: 'Renamed', inventoryUrl: 'https://inv.example' });

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/integrations/${id}`, headers: owner.headers });
    expect(del.json()).toEqual({ ok: true });
  });

  it('requires a user', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/v1/integrations' })).statusCode).toBe(401);
  });
});

describe('integrations: CMDB feed for Umbrella', () => {
  it('exports sites, racks and devices with identities and relations', async () => {
    const { app, owner, id } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/v1/integrations/${id}/umbrella/ci`, headers: owner.headers });
    expect(res.statusCode).toBe(200);
    const feed = res.json();
    expect(feed).toMatchObject({ source: 'inventory-db', integration_id: id, count: 4, next_offset: null });
    const app01 = feed.items.find((c: any) => c.source_ref === 'inventory-db:dcim.device:100');
    expect(app01).toMatchObject({
      type: 'device',
      name: 'App-01',
      status: 'active',
      monitored: true,
      url: 'https://inv.example/dcim/devices/100',
      identities: { hostname: 'app-01', fqdn: ['app-01.corp.example'], ip: ['10.0.0.5', '10.0.0.6'], serial: 'SN100' },
      attributes: { role: 'Server', manufacturer: 'Dell', model: 'R650', rack: 'R01', tags: ['prod'] },
    });
    expect(app01.relations).toEqual([
      { type: 'located_in', direction: 'out', target_ref: 'inventory-db:dcim.rack:10' },
      { type: 'connected_to', direction: 'out', target_ref: 'inventory-db:dcim.device:101', via: 'cable 5' },
    ]);
    const sw = feed.items.find((c: any) => c.source_ref === 'inventory-db:dcim.device:101');
    expect(sw).toMatchObject({ monitored: false, relations: [{ type: 'located_in', target_ref: 'inventory-db:dcim.site:1' }] });
  });

  it('pages with offset and limit', async () => {
    const { app, owner, id } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/v1/integrations/${id}/umbrella/ci?limit=3`, headers: owner.headers });
    expect(res.json()).toMatchObject({ count: 4, offset: 0, next_offset: 3 });
    const res2 = await app.inject({ method: 'GET', url: `/api/v1/integrations/${id}/umbrella/ci?offset=3&limit=3`, headers: owner.headers });
    expect(res2.json()).toMatchObject({ next_offset: null });
    expect(res2.json().items).toHaveLength(1);
  });

  it('is unavailable for an inactive integration and without a token', async () => {
    const { app, owner, id } = await setup();
    expect((await app.inject({ method: 'GET', url: `/api/v1/integrations/${id}/umbrella/ci` })).statusCode).toBe(401);
    await app.inject({ method: 'PATCH', url: `/api/v1/integrations/${id}`, headers: owner.headers, payload: { active: false } });
    expect((await app.inject({ method: 'GET', url: `/api/v1/integrations/${id}/umbrella/ci`, headers: owner.headers })).statusCode).toBe(404);
  });
});

describe('integrations: alerts from Umbrella', () => {
  const alert = (over: Record<string, unknown> = {}) => ({
    alert_id: 'a1',
    status: 'open',
    severity: 'error',
    title: 'CPU > 95% on app-01',
    signal: 'use.cpu.utilization',
    ci: { source_refs: ['inventory-db:dcim.device:100'] },
    links: { incident: 'https://umbrella.example/incidents/a1', grafana: 'https://umbrella.example/go/incidents/a1/grafana' },
    updated_at: '2026-10-08T10:00:00Z',
    ...over,
  });

  it('rejects unsigned, badly signed and stale requests', async () => {
    const { app, id, secret } = await setup();
    const url = `/api/v1/integrations/${id}/umbrella/alerts`;
    expect((await app.inject({ method: 'POST', url, payload: alert() })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, ...signed('whsec_wrong', alert()) })).statusCode).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await app.inject({ method: 'POST', url, ...signed(secret, alert(), stale) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/integrations/int_nope/umbrella/alerts', ...signed(secret, alert()) })).statusCode).toBe(401);
  });

  it('tracks alert state per device and rolls it up to the worst severity', async () => {
    const { app, owner, id, secret } = await setup();
    const url = `/api/v1/integrations/${id}/umbrella/alerts`;
    const r1 = await app.inject({ method: 'POST', url, ...signed(secret, alert()) });
    expect(r1.statusCode).toBe(202);
    expect(r1.json().results).toEqual([{ alert_id: 'a1', matched: ['dcim.device:100'] }]);
    await app.inject({
      method: 'POST',
      url,
      ...signed(secret, [alert({ alert_id: 'a2', severity: 'critical', title: 'Host down', updated_at: '2026-10-08T10:01:00Z' })]),
    });

    const status = await app.inject({ method: 'GET', url: '/api/v1/integrations/umbrella/status?object_type=dcim.device&ids=100,101', headers: owner.headers });
    const [s100, s101] = status.json();
    expect(s100).toMatchObject({ objectId: 100, state: 'critical' });
    expect(s100.alerts.map((a: any) => a.alertId)).toEqual(['a2', 'a1']);
    expect(s100.alerts[1]).toMatchObject({ incidentUrl: 'https://umbrella.example/incidents/a1', signal: 'use.cpu.utilization' });
    expect(s101).toMatchObject({ objectId: 101, state: 'ok', alerts: [] });
    // The DCIM device chips read object_id / status / open_alerts / incident_url.
    expect(s100).toMatchObject({ object_id: 100, status: 'critical', open_alerts: 2 });
    expect(s100.incident_url).toMatch(/^https:\/\/umbrella\.example\/incidents\//);
    expect(s101).toMatchObject({ object_id: 101, status: 'ok', open_alerts: 0, incident_url: null });

    // Resolve a2; an older, out-of-order "open" for a2 must not reopen it.
    await app.inject({ method: 'POST', url, ...signed(secret, alert({ alert_id: 'a2', status: 'resolved', severity: 'critical', updated_at: '2026-10-08T10:05:00Z' })) });
    await app.inject({ method: 'POST', url, ...signed(secret, alert({ alert_id: 'a2', status: 'open', severity: 'critical', updated_at: '2026-10-08T10:02:00Z' })) });
    const after = await app.inject({ method: 'GET', url: '/api/v1/integrations/umbrella/status/dcim.device/100', headers: owner.headers });
    expect(after.json()).toMatchObject({ state: 'error' });
    expect(after.json().history.find((a: any) => a.alertId === 'a2').status).toBe('resolved');

    // Without ids: only objects with active alerts.
    const active = await app.inject({ method: 'GET', url: '/api/v1/integrations/umbrella/status', headers: owner.headers });
    expect(active.json().map((s: any) => s.objectId)).toEqual([100]);
  });

  it('matches CIs Umbrella found elsewhere by hostname, FQDN or IP, and lists the rest as unmatched', async () => {
    const { app, owner, id, secret } = await setup();
    const url = `/api/v1/integrations/${id}/umbrella/alerts`;
    const res = await app.inject({
      method: 'POST',
      url,
      ...signed(secret, [
        alert({ alert_id: 'h', ci: { identities: { hostname: 'APP-01' } } }),
        alert({ alert_id: 'f', ci: { identities: { fqdn: 'app-01.corp.example' } } }),
        alert({ alert_id: 'i', ci: { identities: { ip: ['192.0.2.1', '10.0.0.6'] } } }),
        alert({ alert_id: 'x', title: 'Unknown host', ci: { name: 'ghost-99' } }),
      ]),
    });
    expect(res.json().results.map((r: any) => r.matched)).toEqual([['dcim.device:100'], ['dcim.device:100'], ['dcim.device:100'], []]);
    const unmatched = await app.inject({ method: 'GET', url: `/api/v1/integrations/${id}/umbrella/unmatched`, headers: owner.headers });
    expect(unmatched.json()).toEqual([expect.objectContaining({ alertId: 'x', title: 'Unknown host', ci: { name: 'ghost-99' } })]);
  });

  it('hides alerts of inactive integrations', async () => {
    const { app, owner, id, secret } = await setup();
    await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/umbrella/alerts`, ...signed(secret, alert()) });
    await app.inject({ method: 'PATCH', url: `/api/v1/integrations/${id}`, headers: owner.headers, payload: { active: false } });
    const s = await app.inject({ method: 'GET', url: '/api/v1/integrations/umbrella/status?ids=100', headers: owner.headers });
    expect(s.json()[0].state).toBe('ok');
  });

  it('rejects malformed events', async () => {
    const { app, id, secret } = await setup();
    const res = await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/umbrella/alerts`, ...signed(secret, { alert_id: 'a', status: 'bogus' }) });
    expect(res.statusCode).toBe(400);
  });

  it('rotating the secret invalidates the old one', async () => {
    const { app, owner, id, secret } = await setup();
    const rotated = (await app.inject({ method: 'POST', url: `/api/v1/integrations/${id}/rotate-secret`, headers: owner.headers })).json().secret;
    const url = `/api/v1/integrations/${id}/umbrella/alerts`;
    expect((await app.inject({ method: 'POST', url, ...signed(secret, alert()) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, ...signed(rotated, alert()) })).statusCode).toBe(202);
  });
});

describe('integrations: helpers', () => {
  it('verifies signatures, including a list during rotation', () => {
    const ts = '1700000000';
    const good = sign('s1', ts, '{}');
    expect(verifySignature('s1', ts, good, '{}', 1700000000)).toBe(true);
    expect(verifySignature('s1', ts, `${sign('old', ts, '{}')},${good}`, '{}', 1700000000)).toBe(true);
    expect(verifySignature('s1', ts, good, '{"x":1}', 1700000000)).toBe(false);
    expect(verifySignature('s1', ts, good, '{}', 1700000000 + 301)).toBe(false);
  });

  it('pages through a NetBox-style API and forwards credentials', async () => {
    const dcim = Fastify();
    const seen: (string | undefined)[] = [];
    dcim.get('/api/v1/dcim/devices/', async (req) => {
      seen.push(req.headers['xc-token'] as string | undefined);
      const { offset } = req.query as { offset: string };
      const all = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1 }));
      const results = all.slice(Number(offset), Number(offset) + 1000);
      return { count: all.length, next: Number(offset) + 1000 < all.length ? 'next' : null, previous: null, results };
    });
    const client = injectDcimClient(dcim, { 'xc-token': 't1' });
    expect(await client.list('dcim/devices')).toHaveLength(1500);
    expect(seen).toEqual(['t1', 't1']);
    await expect(client.list('dcim/racks')).rejects.toMatchObject({ statusCode: 503 });
  });
});
