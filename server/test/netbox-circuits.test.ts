import { describe, expect, it } from 'vitest';
import { seedDcim, setupNetbox, type Api } from './netbox-fixtures.js';

const iface = async (api: Api, device: string, name: string) => (await api.get(`/dcim/interfaces?device=${device}&name=${name}`)).results[0];
const term = (object_type: string, object_id: number) => [{ object_type, object_id }];

describe('netbox circuits', () => {
  it('creates providers, circuits and terminations with validation and uniqueness', async () => {
    const { api } = await setupNetbox();
    const { site } = await seedDcim(api);
    const prov = await api.post('/circuits/providers', { name: 'Telco', slug: 'telco' });
    const other = await api.post('/circuits/providers', { name: 'Other' });
    const acc = await api.post('/circuits/provider-accounts', { provider: prov.id, account: 'ACC-1', name: 'Main' });
    expect(acc.display).toBe('Main (ACC-1)');
    expect((await api.invalid('POST', '/circuits/provider-accounts', { provider: prov.id, account: 'acc-1' })).account[0]).toMatch(/already exists/);
    const pn = await api.post('/circuits/provider-networks', { provider: prov.id, name: 'MPLS cloud' });
    const ct = await api.post('/circuits/circuit-types', { name: 'Internet' });
    expect(ct.slug).toBe('internet');

    const c = await api.post('/circuits/circuits', { cid: 'CID-1', provider: 'telco', type: 'internet', status: 'active', commit_rate: 100000, install_date: '2026-01-01', provider_account: acc.id });
    expect(c).toMatchObject({ cid: 'CID-1', display: 'CID-1', provider: { id: prov.id, name: 'Telco' }, type: { name: 'Internet' }, status: { value: 'active', label: 'Active' }, commit_rate: 100000, termination_a: null });
    expect((await api.invalid('POST', '/circuits/circuits', { cid: 'cid-1', provider: prov.id, type: ct.id })).cid[0]).toMatch(/already exists/);
    // same cid at another provider is fine
    await api.post('/circuits/circuits', { cid: 'CID-1', provider: other.id, type: ct.id });
    // account must belong to the provider; termination after install
    const bad = await api.invalid('POST', '/circuits/circuits', { cid: 'X', provider: other.id, type: ct.id, provider_account: acc.id, install_date: '2026-02-01', termination_date: '2026-01-01' });
    expect(bad.provider_account).toBeTruthy();
    expect(bad.termination_date).toBeTruthy();

    const a = await api.post('/circuits/circuit-terminations', { circuit: c.id, term_side: 'A', site: site.id, port_speed: 1000000, upstream_speed: 500000, xconnect_id: 'XC-9' });
    expect(a).toMatchObject({ display: 'CID-1: Termination A', term_side: { value: 'A', label: 'A' }, site: { id: site.id }, xconnect_id: 'XC-9', cable: null, _occupied: false });
    expect((await api.invalid('POST', '/circuits/circuit-terminations', { circuit: c.id, term_side: 'A', site: site.id })).term_side[0]).toMatch(/already exists/);
    expect((await api.invalid('POST', '/circuits/circuit-terminations', { circuit: c.id, term_side: 'Z' })).site).toBeTruthy();
    expect((await api.invalid('POST', '/circuits/circuit-terminations', { circuit: c.id, term_side: 'Z', site: site.id, provider_network: pn.id })).provider_network).toBeTruthy();
    const z = await api.post('/circuits/circuit-terminations', { circuit: c.id, term_side: 'Z', provider_network: pn.id });

    const full = await api.get(`/circuits/circuits/${c.id}`);
    expect(full.termination_a).toMatchObject({ id: a.id, site: { id: site.id }, port_speed: 1000000 });
    expect(full.termination_z).toMatchObject({ id: z.id, provider_network: { id: pn.id } });
    expect((await api.get(`/circuits/circuits?site_id=${site.id}`)).count).toBe(1);
    expect((await api.get(`/circuits/circuit-terminations?provider_id=${prov.id}`)).count).toBe(2);
    expect((await api.get('/circuits/circuits?status=active&provider=telco')).count).toBe(1);
    expect((await api.get(`/circuits/providers/${prov.id}`)).circuit_count).toBe(1);

    // provider can't be deleted while it has circuits; deleting the circuit removes its terminations
    expect((await api.call('DELETE', `/circuits/providers/${prov.id}`)).status).toBe(409);
    await api.del(`/circuits/circuits/${c.id}`);
    expect((await api.get(`/circuits/circuit-terminations?circuit_id=${c.id}`)).count).toBe(0);

    // CSV import by cid
    const r = await api.post('/netbox/import/circuits', { csv: 'cid,provider,type,status\nCID-2,telco,internet,planned' });
    expect(r.results[0].status.value).toBe('planned');
    const tr = await api.post('/netbox/import/circuit-terminations', { csv: 'circuit,term_side,site\nCID-2,A,hq' });
    expect(tr.results[0].display).toBe('CID-2: Termination A');
  });

  it('traces interface → circuit termination A … Z → interface through the circuit', async () => {
    const { api } = await setupNetbox();
    const { site, dt, role } = await seedDcim(api);
    const site2 = await api.post('/dcim/sites', { name: 'DR', slug: 'dr' });
    await api.post('/dcim/devices', { name: 'r1', device_type: dt.id, role: role.id, site: site.id });
    await api.post('/dcim/devices', { name: 'r2', device_type: dt.id, role: role.id, site: site2.id });
    const prov = await api.post('/circuits/providers', { name: 'Telco' });
    const ct = await api.post('/circuits/circuit-types', { name: 'MPLS' });
    const c = await api.post('/circuits/circuits', { cid: 'L2-1', provider: prov.id, type: ct.id });
    const ta = await api.post('/circuits/circuit-terminations', { circuit: c.id, term_side: 'A', site: site.id });
    const tz = await api.post('/circuits/circuit-terminations', { circuit: c.id, term_side: 'Z', site: site2.id });
    const i1 = await iface(api, 'r1', 'eth0');
    const i2 = await iface(api, 'r2', 'eth0');
    const c1 = await api.post('/dcim/cables', { a_terminations: term('dcim.interface', i1.id), b_terminations: term('circuits.circuittermination', ta.id) });
    expect(c1.b_terminations[0]).toMatchObject({ object_type: 'circuits.circuittermination', object_id: ta.id, object: { id: ta.id, circuit: { cid: 'L2-1' } } });

    // half-done: path ends at the far circuit termination, which isn't cabled yet
    let i1s = await api.get(`/dcim/interfaces/${i1.id}`);
    expect(i1s.link_peers_type).toBe('circuits.circuittermination');
    expect(i1s.connected_endpoints).toBeNull();
    let trace = await api.get(`/dcim/interfaces/${i1.id}/trace`);
    expect(trace).toHaveLength(2);
    expect(trace[1][0][0].id).toBe(tz.id);
    expect(trace[1][1]).toBeNull();

    const c2 = await api.post('/dcim/cables', { a_terminations: term('circuits.circuittermination', tz.id), b_terminations: term('dcim.interface', i2.id) });
    trace = await api.get(`/dcim/interfaces/${i1.id}/trace`);
    expect(trace).toHaveLength(2);
    expect(trace[0][0][0].id).toBe(i1.id);
    expect(trace[0][1].id).toBe(c1.id);
    expect(trace[0][2][0].id).toBe(ta.id);
    expect(trace[1][0][0].id).toBe(tz.id);
    expect(trace[1][1].id).toBe(c2.id);
    expect(trace[1][2][0]).toMatchObject({ id: i2.id, device: { name: 'r2' } });
    i1s = await api.get(`/dcim/interfaces/${i1.id}`);
    expect(i1s.connected_endpoints[0]).toMatchObject({ id: i2.id, device: { name: 'r2' } });
    expect(i1s.connected_endpoints_type).toBe('dcim.interface');
    expect(i1s.connected_endpoints_reachable).toBe(true);
    // the reverse direction and the termination's own trace
    const back = await api.get(`/dcim/interfaces/${i2.id}`);
    expect(back.connected_endpoints[0].id).toBe(i1.id);
    // from a termination the path follows its own cable
    expect((await api.get(`/circuits/circuit-terminations/${ta.id}/trace`))[0][2][0].id).toBe(i1.id);
    // filters
    expect((await api.get(`/dcim/cables?circuit_id=${c.id}`)).count).toBe(2);
    expect((await api.get(`/dcim/cables?site_id=${site2.id}`)).count).toBe(1);
    expect((await api.get('/dcim/cables?termination_type=circuits.circuittermination')).count).toBe(2);
    // a cabled termination can't be moved to a provider network; power ports can't be cabled to circuits
    const pn = await api.post('/circuits/provider-networks', { provider: prov.id, name: 'Cloud' });
    expect((await api.invalid('PATCH', `/circuits/circuit-terminations/${tz.id}`, { site: null, provider_network: pn.id })).provider_network).toBeTruthy();
    const pdt = await api.post('/dcim/device-types', { manufacturer: dt.manufacturer.id, model: 'PSU box' });
    await api.post('/dcim/power-port-templates', { device_type: pdt.id, name: 'PSU1' });
    const box = await api.post('/dcim/devices', { name: 'box', device_type: pdt.id, role: role.id, site: site.id });
    const psu = (await api.get(`/dcim/power-ports?device_id=${box.id}`)).results[0];
    await api.del(`/dcim/cables/${c1.id}`);
    const incompatible = await api.invalid('POST', '/dcim/cables', { a_terminations: term('dcim.powerport', psu.id), b_terminations: term('circuits.circuittermination', ta.id) });
    expect(incompatible.b_terminations[0]).toMatch(/Incompatible/);
  });
});
