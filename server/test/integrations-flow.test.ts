import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearFlowCache, setFlowTimeout } from '../src/integrations/current/client.js';
import { configureFlowNotifier, resetFlowNotifier } from '../src/integrations/current/notifier.js';
import { verifySignature } from '../src/integrations/secrets.js';
import { getSecret, useLocalSecrets, useOpenBao } from '../src/system/secrets.js';
import { startFakeOpenBao, type FakeOpenBao } from './fake-openbao.js';
import { createTestApp, grantRole, signInUser } from './helpers.js';
import { makeApi } from './netbox-fixtures.js';

/** A stand-in Current: records every request; answers are set per test. */
interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
  at: number;
}
const flow = {
  server: null as Server | null,
  url: '',
  requests: [] as Recorded[],
  /** Status code / body / delay per request path (without query). */
  handler: (_r: Recorded): { status: number; body?: unknown; delayMs?: number } => ({ status: 404 }),
};

beforeAll(async () => {
  flow.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r: Recorded = { method: req.method!, url: req.url!, headers: req.headers, body, at: Date.now() };
      flow.requests.push(r);
      const out = flow.handler(r);
      setTimeout(() => {
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(out.body === undefined ? '' : JSON.stringify(out.body));
      }, out.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => flow.server!.listen(0, '127.0.0.1', resolve));
  flow.url = `http://127.0.0.1:${(flow.server!.address() as AddressInfo).port}`;
});
afterAll(async () => {
  flow.server?.closeAllConnections();
  await new Promise((resolve) => flow.server?.close(resolve));
});

const statusBody = {
  window: '24h',
  results: {
    '1': {
      in_bps: 7.2e9,
      out_bps: 1.3e9,
      speed_bps: 1e10,
      utilization_in: 0.72,
      utilization_out: 0.13,
      sparkline: { t: ['2026-10-12T09:00:00Z'], in: [1], out: [0.5] },
      flow_url: 'https://flow.corp/visualize?q=x',
      last_seen: '2026-10-12T10:46:00Z',
    },
    '99': { in_bps: 1, out_bps: 2 },
  },
};

beforeEach(() => {
  flow.requests = [];
  flow.handler = (r) => {
    if (r.url.startsWith('/api/integrations/inventory-db/status')) return { status: 200, body: statusBody };
    if (r.url.startsWith('/api/integrations/inventory-db/hook')) return { status: 202, body: { ok: true } };
    return { status: 404 };
  };
  clearFlowCache();
  setFlowTimeout(5000);
  resetFlowNotifier();
  configureFlowNotifier({ intervalMs: 300, retryDelaysMs: [100, 100], timeoutMs: 2000 });
});
afterEach(() => resetFlowNotifier());

async function setup() {
  const app = await createTestApp();
  // The first user that writes DCIM/IPAM becomes its admin; GET /netbox/me does that too.
  const owner = await signInUser(app);
  await app.inject({ method: 'GET', url: '/api/v1/netbox/me', headers: owner.headers });
  return { app, owner, api: makeApi(app, owner.headers) };
}

async function createFlow(app: FastifyInstance, headers: Record<string, string>, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/integrations',
    headers,
    payload: { kind: 'flow', title: 'Current prod', flowUrl: `${flow.url}/`, flowToken: 'flow_token-123', ...extra },
  });
  return res;
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};
async function pollIntegration(app: FastifyInstance, headers: Record<string, string>, id: string, pred: (i: any) => boolean) {
  const end = Date.now() + 5000;
  for (;;) {
    const i = (await app.inject({ method: 'GET', url: `/api/v1/integrations/${id}`, headers })).json();
    if (pred(i)) return i;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(i)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const hooks = () => flow.requests.filter((r) => r.url === '/api/integrations/inventory-db/hook');

describe('flow integration: management', () => {
  it('creates a flow integration, keeps the token server-side and adds the snmp_index custom field once', async () => {
    const { app, owner, api } = await setup();
    const res = await createFlow(app, owner.headers);
    expect(res.statusCode).toBe(201);
    const { integration, secret } = res.json();
    expect(secret).toMatch(/^whsec_/);
    expect(integration).toMatchObject({ kind: 'flow', flowUrl: flow.url, flowTokenSet: true, lastDelivery: null });
    const list = await app.inject({ method: 'GET', url: '/api/v1/integrations', headers: owner.headers });
    expect(list.body).not.toContain('flow_token-123');
    expect(list.body).not.toContain(secret);
    expect(await getSecret(`integrations/${integration.id}`, 'flow_token')).toBe('flow_token-123');

    const cfs = await api.get('/extras/custom-fields?name=snmp_index');
    expect(cfs.results).toHaveLength(1);
    expect(cfs.results[0]).toMatchObject({ name: 'snmp_index', type: { value: 'integer' }, object_types: ['dcim.interface'] });
    expect((await createFlow(app, owner.headers, { title: 'Second' })).statusCode).toBe(201);
    expect((await api.get('/extras/custom-fields?name=snmp_index')).results).toHaveLength(1);

    // A new token replaces the stored one; the URL can change.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/integrations/${integration.id}`,
      headers: owner.headers,
      payload: { flowToken: 'flow_new', flowUrl: 'https://flow.example/' },
    });
    expect(patched.json()).toMatchObject({ flowUrl: 'https://flow.example', flowTokenSet: true });
    expect(await getSecret(`integrations/${integration.id}`, 'flow_token')).toBe('flow_new');
  });

  it('needs the DCIM/IPAM admin role, a URL and a token', async () => {
    const { app, owner } = await setup();
    const viewer = await signInUser(app);
    expect((await createFlow(app, viewer.headers)).statusCode).toBe(403);
    expect((await createFlow(app, owner.headers, { flowToken: '' })).statusCode).toBe(400);
    expect((await createFlow(app, owner.headers, { flowUrl: 'ftp://x' })).statusCode).toBe(400);
  });

  it('lets every DCIM/IPAM admin, and only admins, see and manage Current integrations', async () => {
    const { app, owner, api } = await setup();
    const created = (await createFlow(app, owner.headers)).json().integration;
    const umbrella = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/integrations',
        headers: owner.headers,
        payload: { kind: 'umbrella', title: 'Beacon prod', inventoryUrl: 'https://inv.example' },
      })
    ).json().integration;
    const other = await signInUser(app);
    const list = async (h: Record<string, string>) =>
      ((await app.inject({ method: 'GET', url: '/api/v1/integrations', headers: h })).json() as { id: string }[]).map((i) => i.id);
    const patch = (h: Record<string, string>, id: string) =>
      app.inject({ method: 'PATCH', url: `/api/v1/integrations/${id}`, headers: h, payload: { title: 'Renamed' } });

    // A viewer sees none of them and cannot create one.
    expect(await list(other.headers)).toEqual([]);
    expect((await patch(other.headers, created.id)).statusCode).toBe(404);

    // Made admin: sees and manages the Current integration, not someone else's Beacon one.
    grantRole(other.userId, 'admin');
    expect(await list(other.headers)).toEqual([created.id]);
    expect((await patch(other.headers, created.id)).json()).toMatchObject({ title: 'Renamed' });
    expect((await patch(other.headers, umbrella.id)).statusCode).toBe(404);
    const rotated = await app.inject({ method: 'POST', url: `/api/v1/integrations/${created.id}/rotate-secret`, headers: other.headers });
    expect(rotated.json().secret).toMatch(/^whsec_/);

    // The creator, no longer admin, loses access to the Current integration but keeps their own Beacon one.
    grantRole(owner.userId, 'editor');
    expect(await list(owner.headers)).toEqual([umbrella.id]);
    expect((await patch(owner.headers, created.id)).statusCode).toBe(404);
    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/integrations/${created.id}`, headers: other.headers });
    expect(removed.statusCode).toBe(200);
  });

  it('stores the Current token in OpenBao when it is configured', async () => {
    const bao: FakeOpenBao = await startFakeOpenBao();
    try {
      await useOpenBao({ addr: bao.url, mount: 'inventory', auth: 'token', token: bao.token });
      const { app, owner } = await setup();
      const { integration, secret } = (await createFlow(app, owner.headers)).json();
      expect(bao.store.get('inventory')!.get(`integrations/${integration.id}`)).toEqual({ signing_secret: secret, flow_token: 'flow_token-123' });
    } finally {
      useLocalSecrets();
      await bao.close();
    }
  });
});

describe('flow integration: traffic proxy', () => {
  it('answers 404 without an active flow integration', async () => {
    const { app, owner } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/v1/integrations/flow/status?object_type=dcim.device&ids=1', headers: owner.headers });
    expect(res.statusCode).toBe(404);
    expect(flow.requests).toHaveLength(0);
  });

  it('calls Current with the token, returns only the asked ids and caches for a minute', async () => {
    const { app, owner } = await setup();
    await createFlow(app, owner.headers);
    const viewer = await signInUser(app);
    const url = '/api/v1/integrations/flow/status?object_type=dcim.device&ids=1,2';
    const res = await app.inject({ method: 'GET', url, headers: viewer.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ window: '24h', results: { '1': statusBody.results['1'] } });
    expect(flow.requests).toHaveLength(1);
    expect(flow.requests[0].url).toBe('/api/integrations/inventory-db/status?object_type=dcim.device&ids=1%2C2');
    expect(flow.requests[0].headers.authorization).toBe('Bearer flow_token-123');

    await app.inject({ method: 'GET', url, headers: viewer.headers });
    expect(flow.requests).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/v1/integrations/flow/status?object_type=dcim.device&ids=1,2' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/integrations/flow/status?object_type=dcim.site&ids=1', headers: viewer.headers })).statusCode).toBe(400);
  });

  it('maps Current failures to 502 and Current 404 to 404, and ignores inactive integrations', async () => {
    const { app, owner } = await setup();
    const { integration } = (await createFlow(app, owner.headers)).json();
    flow.handler = () => ({ status: 500, body: { error: 'boom' } });
    const get = (ids: string) => app.inject({ method: 'GET', url: `/api/v1/integrations/flow/status?object_type=dcim.interface&ids=${ids}`, headers: owner.headers });
    expect((await get('1')).statusCode).toBe(502);
    flow.handler = () => ({ status: 404 });
    expect((await get('2')).statusCode).toBe(404);
    setFlowTimeout(100);
    flow.handler = () => ({ status: 200, body: statusBody, delayMs: 500 });
    const slow = await get('3');
    expect(slow.statusCode).toBe(502);
    expect(slow.json().message).toMatch(/in time/);
    await app.inject({ method: 'PATCH', url: `/api/v1/integrations/${integration.id}`, headers: owner.headers, payload: { active: false } });
    expect((await get('4')).statusCode).toBe(404);
  });

  it('lists the addresses Current saw in a prefix and marks those in IPAM', async () => {
    const { app, owner, api } = await setup();
    await createFlow(app, owner.headers);
    const ip = await api.post('/ipam/ip-addresses', { address: '10.0.0.7/24' });
    flow.handler = (r) => ({
      status: 200,
      body: {
        prefix: '10.0.0.0/24',
        results: [
          { address: '10.0.0.7', bytes: 2000, flows: 4, last_seen: '2026-10-12T10:40:00Z', in_ipam: false },
          { address: '10.0.0.8', bytes: 1000, flows: 2, last_seen: '2026-10-12T10:41:00Z', in_ipam: true },
        ],
        echo: r.url,
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/integrations/flow/prefix-addresses?prefix=10.0.0.5/24', headers: owner.headers });
    expect(res.statusCode).toBe(200);
    expect(flow.requests[0].url).toBe('/api/integrations/inventory-db/prefix-addresses?prefix=10.0.0.0%2F24');
    expect(res.json()).toEqual({
      prefix: '10.0.0.0/24',
      results: [
        { address: '10.0.0.7', bytes: 2000, flows: 4, last_seen: '2026-10-12T10:40:00Z', in_ipam: true, ip_address_id: ip.id },
        { address: '10.0.0.8', bytes: 1000, flows: 2, last_seen: '2026-10-12T10:41:00Z', in_ipam: false, ip_address_id: null },
      ],
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/integrations/flow/prefix-addresses?prefix=nope', headers: owner.headers })).statusCode).toBe(400);
  });
});

describe('flow integration: change notifications', () => {
  it('signs the hook like the contract says', async () => {
    const { app, owner, api } = await setup();
    const { integration, secret } = (await createFlow(app, owner.headers)).json();
    const site = await api.post('/dcim/sites', { name: 'DC1', slug: 'dc1' });
    await waitFor(() => hooks().length === 1);
    const [hook] = hooks();
    const ts = hook.headers['x-inventory-timestamp'] as string;
    const sig = hook.headers['x-inventory-signature'] as string;
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifySignature(secret, ts, sig, hook.body)).toBe(true);
    expect(verifySignature('whsec_wrong', ts, sig, hook.body)).toBe(false);
    const body = JSON.parse(hook.body);
    expect(body).toMatchObject({ integration_id: integration.id, events: [{ event: 'object.created', object_type: 'dcim.site', id: site.id }] });
    expect(new Date(body.sent_at).getTime()).toBeGreaterThan(0);
    expect(hook.headers.authorization).toBeUndefined();

    const delivered = await pollIntegration(app, owner.headers, integration.id, (i) => !!i.lastDelivery);
    expect(delivered.lastDelivery).toMatchObject({ ok: true, httpStatus: 202, events: 1, attempts: 1 });
  });

  it('coalesces a burst into one request and sends at most one per interval', async () => {
    const { app, owner, api } = await setup();
    await createFlow(app, owner.headers);
    const site = await api.post('/dcim/sites', { name: 'DC1', slug: 'dc1' });
    for (let n = 0; n < 5; n++) await api.patch(`/dcim/sites/${site.id}`, { description: `v${n}` });
    await api.post('/ipam/ip-addresses', { address: '10.1.0.1/24' });
    await api.post('/tenancy/tenants', { name: 'T', slug: 't' }); // not DCIM/IPAM/circuits: not sent
    await waitFor(() => hooks().length === 1);
    const first = JSON.parse(hooks()[0].body);
    expect(first.events).toEqual([
      { event: 'object.created', object_type: 'dcim.site', id: site.id },
      { event: 'object.created', object_type: 'ipam.ipaddress', id: expect.any(Number) },
    ]);

    // Changes right after a delivery wait for the next window.
    await api.patch(`/dcim/sites/${site.id}`, { description: 'later' });
    await api.del(`/dcim/sites/${site.id}`);
    await waitFor(() => hooks().length === 2);
    expect(hooks()[1].at - hooks()[0].at).toBeGreaterThanOrEqual(290);
    expect(JSON.parse(hooks()[1].body).events).toEqual([{ event: 'object.deleted', object_type: 'dcim.site', id: site.id }]);
    await new Promise((r) => setTimeout(r, 500));
    expect(hooks()).toHaveLength(2);
  });

  it('retries failed deliveries with backoff and records the result', async () => {
    const { app, owner, api } = await setup();
    const { integration } = (await createFlow(app, owner.headers)).json();
    let n = 0;
    flow.handler = () => (++n === 1 ? { status: 503 } : { status: 202 });
    await api.post('/dcim/sites', { name: 'DC1', slug: 'dc1' });
    await waitFor(() => hooks().length === 2);
    expect(hooks()[1].at - hooks()[0].at).toBeGreaterThanOrEqual(290);
    let i = await pollIntegration(app, owner.headers, integration.id, (x) => !!x.lastDelivery);
    expect(i.lastDelivery).toMatchObject({ ok: true, attempts: 2 });

    // Bad answers that retrying won't fix are recorded at once.
    flow.handler = () => ({ status: 401 });
    await api.post('/dcim/sites', { name: 'DC2', slug: 'dc2' });
    await waitFor(() => hooks().length === 3);
    i = await pollIntegration(app, owner.headers, integration.id, (x) => x.lastDelivery?.httpStatus === 401);
    expect(i.lastDelivery).toMatchObject({ ok: false, httpStatus: 401, error: 'HTTP 401', attempts: 1 });
  });

  it('signs with both secrets for a while after a rotation', async () => {
    const { app, owner, api } = await setup();
    const { integration, secret: old } = (await createFlow(app, owner.headers)).json();
    const fresh = (await app.inject({ method: 'POST', url: `/api/v1/integrations/${integration.id}/rotate-secret`, headers: owner.headers })).json().secret;
    await api.post('/dcim/sites', { name: 'DC1', slug: 'dc1' });
    await waitFor(() => hooks().length === 1);
    const [hook] = hooks();
    const ts = hook.headers['x-inventory-timestamp'] as string;
    const sig = hook.headers['x-inventory-signature'] as string;
    expect(sig.split(',')).toHaveLength(2);
    expect(verifySignature(fresh, ts, sig, hook.body)).toBe(true);
    expect(verifySignature(old, ts, sig, hook.body)).toBe(true);
  });

  it('sends nothing for inactive integrations', async () => {
    const { app, owner, api } = await setup();
    await createFlow(app, owner.headers, { active: false });
    await api.post('/dcim/sites', { name: 'DC1', slug: 'dc1' });
    await new Promise((r) => setTimeout(r, 600));
    expect(hooks()).toHaveLength(0);
  });
});
