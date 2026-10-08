import { describe, expect, it } from 'vitest';
import { netboxEvents } from '../src/netbox/events.js';
import { seedDcim, setupNetbox } from './netbox-fixtures.js';

describe('netbox dcim', () => {
  it('creates a device from a device type, copying interface templates, with NetBox shapes', async () => {
    const { api } = await setupNetbox();
    const { site, dt, role, rack } = await seedDcim(api);
    expect(site.status).toEqual({ value: 'active', label: 'Active' });
    expect(role.color).toBe('4caf50');
    expect(dt.slug).toBe('switch-48');

    const dev = await api.post('/dcim/devices', { name: 'sw1', device_type: dt.id, role: 'access', site: 'hq', rack: rack.id, position: 1, face: 'front', serial: 'SN1' });
    expect(dev).toMatchObject({
      name: 'sw1',
      display: 'sw1',
      url: `/api/v1/dcim/devices/${dev.id}/`,
      status: { value: 'active', label: 'Active' },
      role: { id: role.id, name: 'Access switch', slug: 'access', color: '4caf50', display: 'Access switch' },
      device_type: { id: dt.id, model: 'Switch 48', slug: 'switch-48', manufacturer: { name: 'Acme', slug: 'acme' } },
      site: { id: site.id, name: 'HQ', slug: 'hq' },
      rack: { id: rack.id, name: 'R1' },
      primary_ip4: null,
      serial: 'SN1',
      tags: [],
      custom_fields: {},
      interface_count: 3,
    });
    expect(dev.device_type.manufacturer.url).toMatch(/^\/api\/v1\/dcim\/manufacturers\/\d+\/$/);
    expect(dev.created).toBeTruthy();
    expect(dev.last_updated).toBeTruthy();

    const ifaces = await api.get(`/dcim/interfaces?device_id=${dev.id}`);
    expect(ifaces.results.map((i: any) => i.name)).toEqual(['eth0', 'eth1', 'mgmt0']);
    expect(ifaces.results[2].mgmt_only).toBe(true);
    expect(ifaces.results[0].type).toEqual({ value: '1000base-t', label: '1000BASE-T (1GE)' });

    // name unique per site (+tenant)
    const dup = await api.invalid('POST', '/dcim/devices', { name: 'SW1', device_type: dt.id, role: role.id, site: site.id });
    expect(dup.name[0]).toMatch(/already exists/);
  });

  it('validates rack positions (fit + overlap) and renders the elevation', async () => {
    const { api } = await setupNetbox();
    const { site, dt, role, rack, mfr } = await seedDcim(api);
    const base = { device_type: dt.id, role: role.id, site: site.id, rack: rack.id, face: 'front' };
    const a = await api.post('/dcim/devices', { ...base, name: 'a', position: 1 }); // U1-U2
    // overlap: U2-U3
    const overlap = await api.invalid('POST', '/dcim/devices', { ...base, name: 'b', position: 2 });
    expect(overlap.position[0]).toMatch(/occupied/);
    // doesn't fit: 2U at U10 in a 10U rack
    const fit = await api.invalid('POST', '/dcim/devices', { ...base, name: 'c', position: 10 });
    expect(fit.position[0]).toMatch(/outside the rack/);
    // position without face
    const noFace = await api.invalid('POST', '/dcim/devices', { ...base, face: undefined, name: 'd', position: 5 });
    expect(noFace.face).toBeTruthy();
    // a half-depth device on the rear can share units with another half-depth device on the front
    const half = await api.post('/dcim/device-types', { manufacturer: mfr.id, model: 'Patch', u_height: 1, is_full_depth: false });
    await api.post('/dcim/devices', { ...base, device_type: half.id, name: 'p-front', position: 5 });
    await api.post('/dcim/devices', { ...base, device_type: half.id, name: 'p-rear', position: 5, face: 'rear' });
    // full-depth device occupies both faces
    const rearClash = await api.invalid('POST', '/dcim/devices', { ...base, device_type: half.id, name: 'x', position: 1, face: 'rear' });
    expect(rearClash.position).toBeTruthy();
    // moving a device into a free spot works
    const moved = await api.patch(`/dcim/devices/${a.id}`, { position: 7 });
    expect(moved.position).toBe(7);
    // rack can't shrink below installed devices
    const shrink = await api.invalid('PATCH', `/dcim/racks/${rack.id}`, { u_height: 6 });
    expect(shrink.u_height).toBeTruthy();

    const front = await api.get(`/dcim/racks/${rack.id}/elevation?face=front`);
    expect(front.count).toBe(10);
    expect(front.results[0].name).toBe('U10'); // top-down
    const u8 = front.results.find((u: any) => u.id === 8);
    const u7 = front.results.find((u: any) => u.id === 7);
    expect(u8.device).toMatchObject({ id: a.id, name: 'a', position: 7, u_height: 2, role_color: '4caf50' });
    expect(u7.occupied).toBe(true);
    expect(front.results.find((u: any) => u.id === 5).device.name).toBe('p-front');
    const rear = await api.get(`/dcim/racks/${rack.id}/elevation?face=rear`);
    expect(rear.results.find((u: any) => u.id === 5).device.name).toBe('p-rear');
    expect(rear.results.find((u: any) => u.id === 7).device.name).toBe('a');
    const rackObj = await api.get(`/dcim/racks/${rack.id}`);
    expect(rackObj.device_count).toBe(3);
    expect(rackObj._utilization).toBe(30);
  });

  it('connects interfaces with cables and traces the path', async () => {
    const { api } = await setupNetbox();
    const { site, dt, role } = await seedDcim(api);
    const d1 = await api.post('/dcim/devices', { name: 'd1', device_type: dt.id, role: role.id, site: site.id });
    const d2 = await api.post('/dcim/devices', { name: 'd2', device_type: dt.id, role: role.id, site: site.id });
    const i1 = (await api.get(`/dcim/interfaces?device_id=${d1.id}&name=eth0`)).results[0];
    const i2 = (await api.get(`/dcim/interfaces?device=d2&name=eth0`)).results[0];
    const cable = await api.post('/dcim/cables', {
      a_terminations: [{ object_type: 'dcim.interface', object_id: i1.id }],
      b_terminations: [{ object_type: 'dcim.interface', object_id: i2.id }],
      type: 'cat6',
      label: 'C-001',
      length: 3,
      length_unit: 'm',
    });
    expect(cable.status).toEqual({ value: 'connected', label: 'Connected' });
    expect(cable.a_terminations).toEqual([
      { object_type: 'dcim.interface', object_id: i1.id, object: expect.objectContaining({ id: i1.id, name: 'eth0', device: expect.objectContaining({ id: d1.id, name: 'd1' }) }) },
    ]);

    const i1b = await api.get(`/dcim/interfaces/${i1.id}`);
    expect(i1b.cable).toMatchObject({ id: cable.id, label: 'C-001' });
    expect(i1b.link_peers[0]).toMatchObject({ id: i2.id, name: 'eth0' });
    expect(i1b.connected_endpoints[0].device.name).toBe('d2');

    // an interface can't take a second cable
    const i3 = (await api.get(`/dcim/interfaces?device_id=${d2.id}&name=eth1`)).results[0];
    const again = await api.invalid('POST', '/dcim/cables', { a_terminations: [{ object_type: 'dcim.interface', object_id: i1.id }], b_terminations: [{ object_type: 'dcim.interface', object_id: i3.id }] });
    expect(again.a_terminations[0]).toMatch(/already has a cable/);
    // length requires a unit
    const unit = await api.invalid('POST', '/dcim/cables', { a_terminations: [i3.id], b_terminations: [(await api.get(`/dcim/interfaces?device_id=${d1.id}&name=eth1`)).results[0].id], length: 2 });
    expect(unit.length_unit).toBeTruthy();

    const trace = await api.get(`/dcim/interfaces/${i1.id}/trace`);
    expect(trace).toHaveLength(1);
    const [near, c, far] = trace[0];
    expect(near[0].id).toBe(i1.id);
    expect(c.id).toBe(cable.id);
    expect(far[0].id).toBe(i2.id);
    expect(far[0].device.name).toBe('d2');

    const byDevice = await api.get(`/dcim/cables?device_id=${d2.id}`);
    expect(byDevice.count).toBe(1);

    // deleting the cable frees both interfaces
    await api.del(`/dcim/cables/${cable.id}`);
    expect((await api.get(`/dcim/interfaces/${i2.id}`)).cable).toBeNull();
    expect(await api.get(`/dcim/interfaces/${i1.id}/trace`)).toEqual([]);
  });

  it('validates LAG membership and VLAN modes on interfaces', async () => {
    const { api } = await setupNetbox();
    const { site, dt, role } = await seedDcim(api);
    const d1 = await api.post('/dcim/devices', { name: 'd1', device_type: dt.id, role: role.id, site: site.id });
    const lag = await api.post('/dcim/interfaces', { device: d1.id, name: 'bond0', type: 'lag' });
    const eth0 = (await api.get(`/dcim/interfaces?device_id=${d1.id}&name=eth0`)).results[0];
    const member = await api.patch(`/dcim/interfaces/${eth0.id}`, { lag: lag.id, mtu: 9000, mac_address: 'aa-bb-cc-dd-ee-ff' });
    expect(member.lag).toMatchObject({ id: lag.id, name: 'bond0' });
    expect(member.mac_address).toBe('AA:BB:CC:DD:EE:FF');
    const eth1 = (await api.get(`/dcim/interfaces?device_id=${d1.id}&name=eth1`)).results[0];
    const notLag = await api.invalid('PATCH', `/dcim/interfaces/${eth1.id}`, { lag: eth0.id });
    expect(notLag.lag[0]).toMatch(/not a LAG/);
    const vlan10 = await api.post('/ipam/vlans', { vid: 10, name: 'users', site: site.id });
    const vlan20 = await api.post('/ipam/vlans', { vid: 20, name: 'voice', site: site.id });
    const trunk = await api.patch(`/dcim/interfaces/${eth1.id}`, { mode: 'tagged', untagged_vlan: vlan10.id, tagged_vlans: [vlan10.id, vlan20.id] });
    expect(trunk.tagged_vlans.map((v: any) => v.vid)).toEqual([10, 20]);
    expect((await api.get(`/dcim/interfaces?vlan_id=${vlan20.id}`)).count).toBe(1);
    const access = await api.patch(`/dcim/interfaces/${eth1.id}`, { mode: 'access' });
    expect(access.tagged_vlans).toEqual([]);
    expect(access.untagged_vlan.vid).toBe(10);
  });

  it('protects referenced objects and cascades owned ones on delete', async () => {
    const { api } = await setupNetbox();
    const { site, dt, role } = await seedDcim(api);
    const d1 = await api.post('/dcim/devices', { name: 'd1', device_type: dt.id, role: role.id, site: site.id });
    const r = await api.call('DELETE', `/dcim/sites/${site.id}`);
    expect(r.status).toBe(409);
    await api.del(`/dcim/devices/${d1.id}`);
    expect((await api.get(`/dcim/interfaces?device_id=${d1.id}`)).count).toBe(0);
  });

  it('emits object events after commit', async () => {
    const { api } = await setupNetbox();
    const seen: string[] = [];
    const h = (e: { objectType: string; id: number }) => seen.push(`${e.objectType}:${e.id}`);
    netboxEvents.on('object.created', h);
    const s = await api.post('/dcim/sites', { name: 'Ev', slug: 'ev' });
    netboxEvents.off('object.created', h);
    expect(seen).toEqual([`dcim.site:${s.id}`]);
    // failed writes emit nothing
    const before = seen.length;
    netboxEvents.on('object.created', h);
    await api.call('POST', '/dcim/sites', { name: 'Ev', slug: 'ev' });
    netboxEvents.off('object.created', h);
    expect(seen.length).toBe(before);
  });
});
