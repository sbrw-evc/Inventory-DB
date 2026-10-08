import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { createTestApp, signUpUser } from './helpers.js';

export type Api = ReturnType<typeof makeApi>;

export function makeApi(app: FastifyInstance, headers: Record<string, string>) {
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { ...headers, ...extraHeaders }, payload: payload as never });
    return { status: res.statusCode, body: res.body ? (safeJson(res.body) as any) : null };
  };
  /** Request that must succeed; returns the JSON body. */
  const ok = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const r = await call(method, url, payload);
    if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return {
    call,
    ok,
    get: (url: string) => ok('GET', url),
    post: (url: string, body: unknown) => ok('POST', url, body),
    patch: (url: string, body: unknown) => ok('PATCH', url, body),
    del: (url: string) => ok('DELETE', url),
    /** Expects a 400 and returns the field errors. */
    async invalid(method: 'POST' | 'PATCH' | 'PUT', url: string, body: unknown) {
      const r = await call(method, url, body);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      return r.body.details;
    },
  };
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** App + first user (admin via the bootstrap rule). */
export async function setupNetbox() {
  const app = await createTestApp();
  const admin = await signUpUser(app);
  const api = makeApi(app, admin.headers);
  await api.get('/netbox/me');
  return { app, api, admin };
}

/** Site, manufacturer, device type (2U, with 3 interface templates), role, rack. */
export async function seedDcim(api: Api) {
  const site = await api.post('/dcim/sites', { name: 'HQ', slug: 'hq' });
  const mfr = await api.post('/dcim/manufacturers', { name: 'Acme', slug: 'acme' });
  const dt = await api.post('/dcim/device-types', { manufacturer: mfr.id, model: 'Switch 48', u_height: 2 });
  await api.post('/dcim/interface-templates', [
    { device_type: dt.id, name: 'eth0', type: '1000base-t' },
    { device_type: dt.id, name: 'eth1', type: '1000base-t' },
    { device_type: dt.id, name: 'mgmt0', type: '1000base-t', mgmt_only: true },
  ]);
  const role = await api.post('/dcim/device-roles', { name: 'Access switch', slug: 'access', color: '#4caf50' });
  const rack = await api.post('/dcim/racks', { name: 'R1', site: site.id, u_height: 10 });
  return { site, mfr, dt, role, rack };
}
