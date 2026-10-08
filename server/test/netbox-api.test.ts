import { describe, expect, it } from 'vitest';
import { signUpUser } from './helpers.js';
import { makeApi, seedDcim, setupNetbox } from './netbox-fixtures.js';

describe('netbox api behaviour', () => {
  it('enforces roles: anonymous 401, viewer read-only, admin grants editor', async () => {
    const { app, api, admin } = await setupNetbox();
    const anon = await app.inject({ method: 'GET', url: '/api/v1/dcim/sites' });
    expect(anon.statusCode).toBe(401);

    const me = await api.get('/netbox/me');
    expect(me).toMatchObject({ role: 'admin', can_write: true, is_admin: true });

    const bob = await signUpUser(app, 'bob@example.com');
    const bobApi = makeApi(app, bob.headers);
    expect((await bobApi.get('/netbox/me')).role).toBe('viewer');
    expect((await bobApi.call('GET', '/dcim/sites')).status).toBe(200);
    expect((await bobApi.call('POST', '/dcim/sites', { name: 'X', slug: 'x' })).status).toBe(403);
    expect((await bobApi.call('GET', '/netbox/roles')).status).toBe(403);

    await api.post('/netbox/roles', { email: 'bob@example.com', role: 'editor' });
    expect((await bobApi.call('POST', '/dcim/sites', { name: 'X', slug: 'x' })).status).toBe(201);
    const roles = await api.get('/netbox/roles');
    expect(roles.results.find((r: any) => r.email === 'bob@example.com').role).toBe('editor');
    // the last admin can't be demoted
    expect((await api.call('PUT', `/netbox/roles/${admin.userId}`, { role: 'viewer' })).status).toBe(409);
  });

  it('lists with pagination, filters, search and ordering; bulk create/update/delete', async () => {
    const { api } = await setupNetbox();
    const created = await api.post(
      '/dcim/sites',
      Array.from({ length: 7 }, (_, i) => ({ name: `Site ${String.fromCharCode(71 - i)}`, status: i % 2 ? 'planned' : 'active', facility: i === 3 ? 'Equinix FR5' : undefined })),
    );
    expect(created).toHaveLength(7);
    const page = await api.get('/dcim/sites?limit=3&offset=0');
    expect(page.count).toBe(7);
    expect(page.results.map((s: any) => s.name)).toEqual(['Site A', 'Site B', 'Site C']);
    expect(page.next).toBe('/api/v1/dcim/sites?limit=3&offset=3');
    expect(page.previous).toBeNull();
    const last = await api.get('/dcim/sites?limit=3&offset=6');
    expect(last.next).toBeNull();
    expect(last.previous).toBe('/api/v1/dcim/sites?limit=3&offset=3');

    expect((await api.get('/dcim/sites?status=planned')).count).toBe(3);
    expect((await api.get('/dcim/sites?status=planned&status=active')).count).toBe(7);
    expect((await api.get('/dcim/sites?status__n=planned')).count).toBe(4);
    expect((await api.get('/dcim/sites?q=equinix')).results[0].name).toBe('Site D');
    expect((await api.get('/dcim/sites?name__ic=site%20b')).count).toBe(1);
    expect((await api.get('/dcim/sites?ordering=-name&limit=1')).results[0].name).toBe('Site G');
    expect((await api.get('/dcim/sites?brief=1&limit=1')).results[0]).toEqual({ id: expect.any(Number), url: expect.any(String), display: 'Site A', name: 'Site A', slug: 'site-a' });
    expect((await api.call('GET', '/dcim/sites?bogus=1')).status).toBe(400);
    expect((await api.call('GET', '/dcim/sites?ordering=nope')).status).toBe(400);

    const ids = created.slice(0, 2).map((s: any) => s.id);
    const upd = await api.patch('/dcim/sites', ids.map((id: number) => ({ id, description: 'bulk' })));
    expect(upd.every((s: any) => s.description === 'bulk')).toBe(true);
    const del = await api.call('DELETE', '/dcim/sites', ids.map((id: number) => ({ id })));
    expect(del.status).toBe(204);
    expect((await api.get('/dcim/sites')).count).toBe(5);

    const errors = await api.invalid('POST', '/dcim/sites', { slug: 'bad slug!', status: 'nope', latitude: 100 });
    expect(Object.keys(errors).sort()).toEqual(['latitude', 'name', 'slug', 'status']);
    expect((await api.call('GET', '/dcim/sites/9999')).status).toBe(404);
  });

  it('filters by related objects (id, slug, nested region tree)', async () => {
    const { api } = await setupNetbox();
    const eu = await api.post('/dcim/regions', { name: 'Europe' });
    const de = await api.post('/dcim/regions', { name: 'Germany', parent: eu.id });
    expect(de._depth).toBe(1);
    await api.post('/dcim/sites', { name: 'Berlin', region: de.id });
    await api.post('/dcim/sites', { name: 'NYC' });
    expect((await api.get(`/dcim/sites?region_id=${eu.id}`)).results.map((s: any) => s.name)).toEqual(['Berlin']);
    expect((await api.get('/dcim/sites?region=germany')).count).toBe(1);
    expect((await api.get('/dcim/sites?region_id=null')).count).toBe(1);
    expect((await api.invalid('PATCH', `/dcim/regions/${eu.id}`, { parent: de.id })).parent).toBeTruthy();
  });

  it('records a change log for create/update/delete', async () => {
    const { api } = await setupNetbox();
    const t = await api.post('/tenancy/tenants', { name: 'Acme Corp' });
    await api.patch(`/tenancy/tenants/${t.id}`, { description: 'customer' });
    await api.del(`/tenancy/tenants/${t.id}`);
    const log = await api.get(`/extras/changelog?changed_object_type=tenancy.tenant&changed_object_id=${t.id}`);
    expect(log.results.map((c: any) => c.action.value)).toEqual(['delete', 'update', 'create']);
    const upd = log.results[1];
    expect(upd.prechange_data.description).toBeNull();
    expect(upd.postchange_data.description).toBe('customer');
    expect(upd.object_repr).toBe('Acme Corp');
    expect(upd.user_name).toBeTruthy();
    expect(upd.time).toBeTruthy();
    expect((await api.get('/extras/object-changes?action=create')).count).toBe(1);
    expect((await api.call('POST', '/extras/object-changes', {})).status).toBe(404);
  });

  it('assigns tags and validates custom fields', async () => {
    const { api } = await setupNetbox();
    const tag = await api.post('/extras/tags', { name: 'Core', color: 'ff0000' });
    await api.post('/extras/tags', { name: 'Edge' });
    await api.post('/extras/custom-fields', { name: 'rack_power', type: 'integer', object_types: ['dcim.site'], validation_maximum: 100, default: 10 });
    await api.post('/extras/custom-fields', { name: 'tier', type: 'select', object_types: ['dcim.site'], choices: ['gold', 'silver'] });
    expect((await api.invalid('POST', '/extras/custom-fields', { name: 'Bad Name', type: 'text', object_types: ['dcim.nope'] })).object_types).toBeTruthy();

    const s = await api.post('/dcim/sites', { name: 'Tagged', tags: ['core', { name: 'Edge' }], custom_fields: { tier: 'gold' } });
    expect(s.tags.map((t: any) => t.slug)).toEqual(['core', 'edge']);
    expect(s.tags[0]).toMatchObject({ id: tag.id, name: 'Core', slug: 'core', color: 'ff0000' });
    expect(s.custom_fields).toEqual({ rack_power: 10, tier: 'gold' });
    await api.post('/dcim/sites', { name: 'Plain' });

    const bad = await api.invalid('PATCH', `/dcim/sites/${s.id}`, { custom_fields: { rack_power: 500, tier: 'bronze', nope: 1 } });
    expect(bad.custom_fields).toHaveLength(3);
    const upd = await api.patch(`/dcim/sites/${s.id}`, { custom_fields: { rack_power: 42 } });
    expect(upd.custom_fields).toEqual({ rack_power: 42, tier: 'gold' });

    expect((await api.get('/dcim/sites?tag=core')).count).toBe(1);
    expect((await api.get('/dcim/sites?tag__n=core')).count).toBe(1);
    expect((await api.get('/dcim/sites?cf_tier=gold')).count).toBe(1);
    expect((await api.get('/dcim/sites?cf_rack_power__gte=40')).count).toBe(1);
    expect((await api.get(`/extras/tags/${tag.id}`)).tagged_items).toBe(1);
    // removing the tag
    await api.del(`/extras/tags/${tag.id}`);
    expect((await api.get(`/dcim/sites/${s.id}`)).tags.map((t: any) => t.slug)).toEqual(['edge']);
  });

  it('imports CSV with references by name/slug and rejects the whole file on errors', async () => {
    const { app, api, admin } = await setupNetbox();
    const { rack } = await seedDcim(api);
    const csv = ['name,device_type,role,site,rack,position,face,status,tags', 'csv1,switch-48,access,hq,R1,1,front,planned,', 'csv2,Switch 48,Access switch,HQ,R1,3,front,active,'].join('\n');
    await api.post('/extras/tags', { name: 'imported' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/netbox/import/dcim.device', headers: { ...admin.headers, 'content-type': 'text/csv' }, payload: csv.replace(/,$/m, ',imported') });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.created).toBe(2);
    expect(body.results[0]).toMatchObject({ name: 'csv1', rack: { id: rack.id }, position: 1, status: { value: 'planned' } });
    expect(body.results[0].tags[0].slug).toBe('imported');

    // IP import with device + interface
    const ipCsv = 'address,status,device,interface,dns_name\n10.1.1.1/24,active,csv1,eth0,csv1.example.com';
    const ipRes = await api.post('/netbox/import/ip-addresses', { csv: ipCsv });
    expect(ipRes.results[0].assigned_object).toMatchObject({ name: 'eth0', device: { name: 'csv1' } });

    // cable import
    const cableCsv = 'side_a_device,side_a_name,side_b_device,side_b_name,type,label\ncsv1,eth1,csv2,eth1,cat6,X1';
    const cab = await api.post('/netbox/import/cables', { csv: cableCsv });
    expect(cab.results[0].a_terminations[0].object.name).toBe('eth1');

    // errors: one bad row rolls back everything
    const bad = 'name,device_type,role,site\nok1,switch-48,access,hq\nbad,nope,access,hq';
    const r = await api.call('POST', '/netbox/import/devices', { csv: bad });
    expect(r.status).toBe(400);
    expect(r.body.details[0].row).toBe(2);
    expect(r.body.details[0].errors.device_type).toBeTruthy();
    expect((await api.get('/dcim/devices?name=ok1')).count).toBe(0);
  });

  it('searches globally and serves the schema', async () => {
    const { api } = await setupNetbox();
    const { site, dt, role } = await seedDcim(api);
    await api.post('/dcim/devices', { name: 'core-router', device_type: dt.id, role: role.id, site: site.id });
    await api.post('/ipam/prefixes', { prefix: '10.20.0.0/16', description: 'core network' });
    const res = await api.get('/netbox/search?q=core');
    const types = res.results.map((r: any) => r.object_type);
    expect(types).toContain('dcim.device');
    expect(types).toContain('ipam.prefix');
    expect(res.results.find((r: any) => r.object_type === 'dcim.device')).toMatchObject({ display: 'core-router', display_url: expect.stringMatching(/^\/dcim\/devices\/\d+$/) });
    const ip = await api.get('/netbox/search?q=10.20.3.4');
    expect(ip.results.map((r: any) => r.display)).toEqual(['10.20.0.0/16']);
    const schema = await api.get('/netbox/schema');
    const dev = schema.results.find((m: any) => m.object_type === 'dcim.device');
    expect(dev.fields.find((f: any) => f.name === 'status').choices[0]).toEqual({ value: 'offline', label: 'Offline' });
  });
});
