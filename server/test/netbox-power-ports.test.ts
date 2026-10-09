import { describe, expect, it } from 'vitest';
import { seedDcim, setupNetbox, type Api } from './netbox-fixtures.js';

const term = (object_type: string, object_id: number) => [{ object_type, object_id }];
const one = async (api: Api, url: string) => (await api.get(url)).results[0];

describe('netbox front/rear ports', () => {
  it('instantiates port templates and traces through patch panels with positions', async () => {
    const { api } = await setupNetbox();
    const { site, dt, role, mfr } = await seedDcim(api);
    // 2-position patch panel: front 1 and 2 share rear port "R" (a 2-strand trunk)
    const pp = await api.post('/dcim/device-types', { manufacturer: mfr.id, model: 'Patch 2', u_height: 1 });
    const rt = await api.post('/dcim/rear-port-templates', { device_type: pp.id, name: 'R', type: 'mpo', positions: 2 });
    await api.post('/dcim/front-port-templates', [
      { device_type: pp.id, name: 'F1', type: 'lc', rear_port: rt.id, rear_port_position: 1 },
      { device_type: pp.id, name: 'F2', type: 'lc', rear_port: rt.id, rear_port_position: 2 },
    ]);
    // template validation
    expect((await api.invalid('POST', '/dcim/front-port-templates', { device_type: pp.id, name: 'F3', type: 'lc', rear_port: rt.id, rear_port_position: 3 })).rear_port_position).toBeTruthy();
    expect((await api.invalid('PATCH', `/dcim/rear-port-templates/${rt.id}`, { positions: 1 })).positions).toBeTruthy();
    expect((await api.get(`/dcim/device-types/${pp.id}`)).front_port_template_count).toBe(2);

    const p1 = await api.post('/dcim/devices', { name: 'pp1', device_type: pp.id, role: role.id, site: site.id });
    const p2 = await api.post('/dcim/devices', { name: 'pp2', device_type: pp.id, role: role.id, site: site.id });
    expect(p1.front_port_count).toBe(2);
    const f = await api.get(`/dcim/front-ports?device_id=${p1.id}&ordering=name`);
    expect(f.results.map((x: any) => [x.name, x.rear_port.name, x.rear_port_position])).toEqual([['F1', 'R', 1], ['F2', 'R', 2]]);
    const r1 = await one(api, `/dcim/rear-ports?device_id=${p1.id}`);
    const r2 = await one(api, `/dcim/rear-ports?device_id=${p2.id}`);
    expect(r1).toMatchObject({ positions: 2, type: { value: 'mpo', label: 'MPO' }, front_port_count: 2 });
    // front port uniqueness per (rear_port, position) and same-device rule
    expect((await api.invalid('POST', '/dcim/front-ports', { device: p1.id, name: 'F9', type: 'lc', rear_port: r1.id, rear_port_position: 1 })).rear_port_position[0]).toMatch(/already exists/);
    expect((await api.invalid('POST', '/dcim/front-ports', { device: p1.id, name: 'F9', type: 'lc', rear_port: r2.id })).rear_port).toBeTruthy();

    const a = await api.post('/dcim/devices', { name: 'sw-a', device_type: dt.id, role: role.id, site: site.id });
    const b = await api.post('/dcim/devices', { name: 'sw-b', device_type: dt.id, role: role.id, site: site.id });
    const ia = await one(api, `/dcim/interfaces?device_id=${a.id}&name=eth1`);
    const ib = await one(api, `/dcim/interfaces?device_id=${b.id}&name=eth1`);
    const ia0 = await one(api, `/dcim/interfaces?device_id=${a.id}&name=eth0`);
    const ib0 = await one(api, `/dcim/interfaces?device_id=${b.id}&name=eth0`);
    const f1 = await one(api, `/dcim/front-ports?device_id=${p1.id}&name=F2`);
    const g1 = await one(api, `/dcim/front-ports?device_id=${p2.id}&name=F2`);
    const f0 = await one(api, `/dcim/front-ports?device_id=${p1.id}&name=F1`);
    const g0 = await one(api, `/dcim/front-ports?device_id=${p2.id}&name=F1`);
    // sw-a eth1 → pp1 F2 ; pp1 R ↔ pp2 R ; pp2 F2 → sw-b eth1 (and position 1 for eth0)
    const c1 = await api.post('/dcim/cables', { a_terminations: term('dcim.interface', ia.id), b_terminations: term('dcim.frontport', f1.id) });
    const trunk = await api.post('/dcim/cables', { a_terminations: term('dcim.rearport', r1.id), b_terminations: term('dcim.rearport', r2.id), type: 'smf' });
    const c3 = await api.post('/dcim/cables', { a_terminations: term('dcim.frontport', g1.id), b_terminations: term('dcim.interface', ib.id) });
    await api.post('/dcim/cables', { a_terminations: term('dcim.interface', ia0.id), b_terminations: term('dcim.frontport', f0.id) });
    await api.post('/dcim/cables', { a_terminations: term('dcim.frontport', g0.id), b_terminations: term('dcim.interface', ib0.id) });

    const trace = await api.get(`/dcim/interfaces/${ia.id}/trace`);
    expect(trace.map((h: any) => [h[0].map((n: any) => n.display), h[1]?.id, h[2].map((n: any) => n.display)])).toEqual([
      [['eth1'], c1.id, ['F2']],
      [['R'], trunk.id, ['R']],
      [['F2'], c3.id, ['eth1']],
    ]);
    expect(trace[2][2][0].device.name).toBe('sw-b');
    const ias = await api.get(`/dcim/interfaces/${ia.id}`);
    expect(ias.link_peers[0]).toMatchObject({ id: f1.id, name: 'F2' });
    expect(ias.link_peers_type).toBe('dcim.frontport');
    expect(ias.connected_endpoints[0]).toMatchObject({ id: ib.id, device: { name: 'sw-b' } });
    // position 1 lands on eth0, not eth1
    expect((await api.get(`/dcim/interfaces/${ia0.id}`)).connected_endpoints[0].id).toBe(ib0.id);
    expect((await api.get(`/dcim/interfaces/${ib0.id}`)).connected_endpoints[0].id).toBe(ia0.id);
    // a rear port's own path splits into positions: ends at the far rear port
    const rp = await api.get(`/dcim/rear-ports/${r1.id}/paths`);
    expect(rp).toHaveLength(1);
    expect((await api.get(`/dcim/rear-ports/${r1.id}`)).connected_endpoints).toBeNull();
    // filters
    expect((await api.get(`/dcim/cables?device_id=${p1.id}`)).count).toBe(3);
    expect((await api.get(`/dcim/front-ports?device_id=${p1.id}&cabled=true`)).count).toBe(2);
    expect((await api.get(`/dcim/cables?rearport_id=${r2.id}`)).results[0].id).toBe(trunk.id);
    // mixing types on one side is rejected
    const mixed = await api.invalid('POST', '/dcim/cables', {
      a_terminations: [{ object_type: 'dcim.interface', object_id: (await one(api, `/dcim/interfaces?device_id=${a.id}&name=mgmt0`)).id }, { object_type: 'dcim.rearport', object_id: (await api.post('/dcim/rear-ports', { device: a.id, name: 'RX', type: '8p8c' })).id }],
      b_terminations: term('dcim.interface', (await one(api, `/dcim/interfaces?device_id=${b.id}&name=mgmt0`)).id),
    });
    expect(mixed.a_terminations[0]).toMatch(/same type/);
    // deleting the panel removes its ports and their cables
    await api.del(`/dcim/devices/${p1.id}`);
    expect((await api.get(`/dcim/interfaces/${ia.id}`)).cable).toBeNull();
    expect((await api.get(`/dcim/rear-ports/${r2.id}`)).cable).toBeNull();
  });
});

describe('netbox power', () => {
  it('models panels, feeds, ports and outlets and computes rack power utilisation', async () => {
    const { api } = await setupNetbox();
    const { site, rack, role, mfr } = await seedDcim(api);
    const other = await api.post('/dcim/sites', { name: 'Other' });
    const otherRack = await api.post('/dcim/racks', { name: 'X1', site: other.id });
    const panel = await api.post('/dcim/power-panels', { site: site.id, name: 'PP-1' });
    expect((await api.invalid('POST', '/dcim/power-panels', { site: site.id, name: 'pp-1' })).name[0]).toMatch(/already exists/);
    // validation: rack in the panel's site; DC can't be three-phase; AC voltage can't be negative
    const bad = await api.invalid('POST', '/dcim/power-feeds', { power_panel: panel.id, name: 'F', rack: otherRack.id, supply: 'dc', phase: 'three-phase' });
    expect(bad.rack).toBeTruthy();
    expect(bad.phase).toBeTruthy();
    expect((await api.invalid('POST', '/dcim/power-feeds', { power_panel: panel.id, name: 'F', voltage: -48 })).voltage).toBeTruthy();

    const feedA = await api.post('/dcim/power-feeds', { power_panel: panel.id, rack: rack.id, name: 'A', voltage: 230, amperage: 16, max_utilization: 80 });
    expect(feedA).toMatchObject({ status: { value: 'active' }, type: { value: 'primary', label: 'Primary' }, supply: { value: 'ac', label: 'AC' }, phase: { value: 'single-phase' }, available_power: 2944, site: { id: site.id } });
    const feedB = await api.post('/dcim/power-feeds', { power_panel: panel.id, rack: rack.id, name: 'B', type: 'redundant', phase: 'three-phase', voltage: 400, amperage: 32, max_utilization: 100 });
    expect(feedB.available_power).toBe(Math.round(400 * 32 * Math.sqrt(3)));
    expect((await api.invalid('POST', '/dcim/power-feeds', { power_panel: panel.id, name: 'a' })).name[0]).toMatch(/already exists/);

    // PDU: inlet + 2 outlets fed from it; servers with PSUs plugged into the outlets
    const pduType = await api.post('/dcim/device-types', { manufacturer: mfr.id, model: 'PDU', u_height: 0 });
    const inT = await api.post('/dcim/power-port-templates', { device_type: pduType.id, name: 'Inlet', type: 'iec-60309-p-n-e-6h' });
    await api.post('/dcim/power-outlet-templates', [
      { device_type: pduType.id, name: 'O1', type: 'iec-60320-c13', power_port: inT.id, feed_leg: 'A' },
      { device_type: pduType.id, name: 'O2', type: 'iec-60320-c13', power_port: inT.id, feed_leg: 'A' },
    ]);
    const srvType = await api.post('/dcim/device-types', { manufacturer: mfr.id, model: 'Server', u_height: 1 });
    await api.post('/dcim/power-port-templates', { device_type: srvType.id, name: 'PSU1', type: 'iec-60320-c14', maximum_draw: 500, allocated_draw: 400 });
    expect((await api.invalid('POST', '/dcim/power-port-templates', { device_type: srvType.id, name: 'PSU2', maximum_draw: 100, allocated_draw: 200 })).allocated_draw).toBeTruthy();

    const pdu = await api.post('/dcim/devices', { name: 'pdu1', device_type: pduType.id, role: role.id, site: site.id, rack: rack.id });
    expect(pdu.power_outlet_count).toBe(2);
    const outlets = await api.get(`/dcim/power-outlets?device_id=${pdu.id}&ordering=name`);
    expect(outlets.results[0]).toMatchObject({ name: 'O1', power_port: { name: 'Inlet' }, feed_leg: { value: 'A' }, type: { label: 'C13' } });
    const inlet = await one(api, `/dcim/power-ports?device_id=${pdu.id}`);
    await api.post('/dcim/cables', { a_terminations: term('dcim.powerport', inlet.id), b_terminations: term('dcim.powerfeed', feedA.id), type: 'power' });

    const servers = [];
    for (const [i, outlet] of outlets.results.entries()) {
      const s = await api.post('/dcim/devices', { name: `srv${i}`, device_type: srvType.id, role: role.id, site: site.id, rack: rack.id, position: i + 1, face: 'front' });
      const psu = await one(api, `/dcim/power-ports?device_id=${s.id}`);
      await api.post('/dcim/cables', { a_terminations: term('dcim.powerport', psu.id), b_terminations: term('dcim.poweroutlet', outlet.id) });
      servers.push(s);
    }
    // interfaces can't be cabled to outlets
    const ifc = await api.post('/dcim/interfaces', { device: servers[0].id, name: 'x', type: '1000base-t' });
    const spare = await api.post('/dcim/power-outlets', { device: pdu.id, name: 'O3', power_port: inlet.id });
    expect((await api.invalid('POST', '/dcim/cables', { a_terminations: term('dcim.interface', ifc.id), b_terminations: term('dcim.poweroutlet', spare.id) })).b_terminations[0]).toMatch(/Incompatible/);

    const inletNow = await api.get(`/dcim/power-ports/${inlet.id}`);
    expect(inletNow._power_draw).toEqual({ allocated: 800, maximum: 1000, outlet_count: 3, connected: 2 });
    expect(inletNow.connected_endpoints[0]).toMatchObject({ id: feedA.id, name: 'A' });
    const feedNow = await api.get(`/dcim/power-feeds/${feedA.id}`);
    expect(feedNow).toMatchObject({ allocated_draw: 800, maximum_draw: 1000, _utilization: 27.2, link_peers_type: 'dcim.powerport' });
    const psuTrace = await api.get(`/dcim/power-ports/${(await one(api, `/dcim/power-ports?device_id=${servers[0].id}`)).id}/trace`);
    expect(psuTrace[0][2][0].name).toBe('O1');

    const power = await api.get(`/dcim/racks/${rack.id}/power`);
    const total = 2944 + feedB.available_power;
    expect(power).toMatchObject({ available_power: total, allocated_draw: 800, maximum_draw: 1000, device_power_ports: 2, device_allocated_draw: 800 });
    expect(power.utilization).toBe(Math.round((800 / total) * 1000) / 10);
    expect(power.feeds.map((f: any) => [f.feed.name, f.utilization])).toEqual([['A', 27.2], ['B', 0]]);
    const rackNow = await api.get(`/dcim/racks/${rack.id}`);
    expect(rackNow._power_utilization).toBe(power.utilization);
    expect(rackNow.powerfeed_count).toBe(2);
    // filters and protection
    expect((await api.get(`/dcim/power-feeds?site_id=${site.id}&cabled=true`)).count).toBe(1);
    expect((await api.get(`/dcim/cables?powerfeed_id=${feedA.id}`)).count).toBe(1);
    expect((await api.call('DELETE', `/dcim/power-panels/${panel.id}`)).status).toBe(409);
    // CSV import of feeds (panel and rack by name)
    const csv = await api.post('/netbox/import/power-feeds', { csv: `site,power_panel,name,rack,voltage,amperage\nhq,PP-1,C,${rack.name},230,32` });
    expect(csv.results[0]).toMatchObject({ name: 'C', rack: { id: rack.id }, available_power: Math.round(230 * 32 * 0.8) });
  });
});
