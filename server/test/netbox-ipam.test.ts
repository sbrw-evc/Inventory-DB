import { describe, expect, it } from 'vitest';
import { seedDcim, setupNetbox } from './netbox-fixtures.js';

describe('netbox ipam', () => {
  it('computes prefix hierarchy, utilisation and allocates next available prefixes and IPs', async () => {
    const { api } = await setupNetbox();
    const top = await api.post('/ipam/prefixes', { prefix: '10.0.0.0/16', status: 'container' });
    expect(top.prefix).toBe('10.0.0.0/16');
    expect(top.family).toEqual({ value: 4, label: 'IPv4' });
    const lan = await api.post('/ipam/prefixes', { prefix: '10.0.1.77/24' }); // normalised
    expect(lan.prefix).toBe('10.0.1.0/24');
    await api.post('/ipam/prefixes', { prefix: '10.0.0.0/24' });

    const topNow = await api.get(`/ipam/prefixes/${top.id}`);
    expect(topNow._depth).toBe(0);
    expect(topNow._children).toBe(2);
    expect(topNow._utilization).toBe(0.8); // 512 / 65536 = 0.78%
    expect((await api.get(`/ipam/prefixes/${lan.id}`))._depth).toBe(1);

    // list ordering is by network, children filters
    const list = await api.get('/ipam/prefixes');
    expect(list.results.map((p: any) => p.prefix)).toEqual(['10.0.0.0/16', '10.0.0.0/24', '10.0.1.0/24']);
    expect((await api.get('/ipam/prefixes?parent=10.0.0.0/16')).count).toBe(2);
    expect((await api.get('/ipam/prefixes?within_include=10.0.0.0/16')).count).toBe(3);
    expect((await api.get('/ipam/prefixes?contains=10.0.1.5')).results.map((p: any) => p.prefix)).toEqual(['10.0.0.0/16', '10.0.1.0/24']);
    expect((await api.get('/ipam/prefixes?depth=0')).count).toBe(1);
    expect((await api.get('/ipam/prefixes?q=10.0.1.9')).count).toBe(2);

    const avail = await api.get(`/ipam/prefixes/${top.id}/available-prefixes`);
    expect(avail.map((p: any) => p.prefix).slice(0, 3)).toEqual(['10.0.2.0/23', '10.0.4.0/22', '10.0.8.0/21']);
    const alloc = await api.post(`/ipam/prefixes/${top.id}/available-prefixes`, [{ prefix_length: 24 }, { prefix_length: 24, description: 'b' }]);
    expect(alloc.map((p: any) => p.prefix)).toEqual(['10.0.2.0/24', '10.0.3.0/24']);
    expect(alloc[1].description).toBe('b');
    const tooBig = await api.call('POST', `/ipam/prefixes/${lan.id}/available-prefixes`, { prefix_length: 8 });
    expect(tooBig.status).toBe(409);

    // IPs inside the /24: network address is skipped
    await api.post('/ipam/ip-addresses', { address: '10.0.1.1/24' });
    const ips = await api.get(`/ipam/prefixes/${lan.id}/available-ips?limit=3`);
    expect(ips.map((i: any) => i.address)).toEqual(['10.0.1.2/24', '10.0.1.3/24', '10.0.1.4/24']);
    const next = await api.post(`/ipam/prefixes/${lan.id}/available-ips`, { dns_name: 'host.example.com' });
    expect(next.address).toBe('10.0.1.2/24');
    expect(next.dns_name).toBe('host.example.com');
    const two = await api.post(`/ipam/prefixes/${lan.id}/available-ips`, [{}, {}]);
    expect(two.map((i: any) => i.address)).toEqual(['10.0.1.3/24', '10.0.1.4/24']);
    expect((await api.get(`/ipam/prefixes/${lan.id}`))._utilization).toBeCloseTo((4 / 254) * 100, 1);
    expect((await api.get('/ipam/ip-addresses?parent=10.0.1.0/24')).count).toBe(4);

    // a full /30 refuses further allocation
    const p30 = await api.post('/ipam/prefixes', { prefix: '192.168.0.0/30' });
    await api.post(`/ipam/prefixes/${p30.id}/available-ips`, [{}, {}]);
    expect((await api.call('POST', `/ipam/prefixes/${p30.id}/available-ips`, {})).status).toBe(409);
    expect((await api.get(`/ipam/prefixes/${p30.id}`))._utilization).toBe(100);
  });

  it('supports IPv6 prefixes and allocation', async () => {
    const { api } = await setupNetbox();
    const p = await api.post('/ipam/prefixes', { prefix: '2001:DB8::/48', status: 'container' });
    expect(p.prefix).toBe('2001:db8::/48');
    expect(p.family.value).toBe(6);
    const sub = await api.post(`/ipam/prefixes/${p.id}/available-prefixes`, { prefix_length: 64 });
    expect(sub.prefix).toBe('2001:db8::/64');
    const ip = await api.post(`/ipam/prefixes/${sub.id}/available-ips`, {});
    expect(ip.address).toBe('2001:db8::1/64');
    const avail = await api.get(`/ipam/prefixes/${p.id}/available-prefixes`);
    expect(avail[0].prefix).toBe('2001:db8:0:1::/64');
    expect((await api.get('/ipam/prefixes?family=6')).count).toBe(2);
  });

  it('enforces IP uniqueness per VRF', async () => {
    const { api } = await setupNetbox();
    await api.post('/ipam/ip-addresses', { address: '10.9.0.1/24' });
    const dup = await api.invalid('POST', '/ipam/ip-addresses', { address: '10.9.0.1/16' });
    expect(dup.address[0]).toMatch(/Duplicate IP address found in global table/);
    // shared roles may duplicate
    await api.post('/ipam/ip-addresses', { address: '10.9.0.1/24', role: 'vip' });

    const red = await api.post('/ipam/vrfs', { name: 'red', rd: '65000:1' });
    const loose = await api.post('/ipam/vrfs', { name: 'loose', enforce_unique: false });
    await api.post('/ipam/ip-addresses', { address: '10.9.0.1/24', vrf: red.id });
    const dupRed = await api.invalid('POST', '/ipam/ip-addresses', { address: '10.9.0.1/24', vrf: red.id });
    expect(dupRed.address[0]).toMatch(/VRF red/);
    await api.post('/ipam/ip-addresses', { address: '10.9.0.1/24', vrf: loose.id });
    await api.post('/ipam/ip-addresses', { address: '10.9.0.1/24', vrf: loose.id });
    expect((await api.get('/ipam/ip-addresses?vrf_id=null')).count).toBe(2);
    expect((await api.get(`/ipam/ip-addresses?vrf=${encodeURIComponent('red')}`)).count).toBe(1);

    // prefixes too
    await api.post('/ipam/prefixes', { prefix: '10.9.0.0/24', vrf: red.id });
    expect((await api.invalid('POST', '/ipam/prefixes', { prefix: '10.9.0.0/24', vrf: red.id })).prefix[0]).toMatch(/Duplicate prefix/);
    const vrf = await api.get(`/ipam/vrfs/${red.id}`);
    expect(vrf.display).toBe('red (65000:1)');
    expect(vrf.ipaddress_count).toBe(1);

    const bad = await api.invalid('POST', '/ipam/ip-addresses', { address: '10.9.0.300/24', dns_name: 'bad name' });
    expect(bad.address).toBeTruthy();
  });

  it('assigns IPs to interfaces and sets device primary IP', async () => {
    const { api } = await setupNetbox();
    const { site, dt, role } = await seedDcim(api);
    const dev = await api.post('/dcim/devices', { name: 'r1', device_type: dt.id, role: role.id, site: site.id });
    const other = await api.post('/dcim/devices', { name: 'r2', device_type: dt.id, role: role.id, site: site.id });
    const eth0 = (await api.get(`/dcim/interfaces?device_id=${dev.id}&name=eth0`)).results[0];
    const ip = await api.post('/ipam/ip-addresses', { address: '172.16.0.10/24', assigned_object_type: 'dcim.interface', assigned_object_id: eth0.id });
    expect(ip.assigned_object).toMatchObject({ id: eth0.id, name: 'eth0', device: { id: dev.id, name: 'r1' } });
    expect(ip.assigned_object_type).toBe('dcim.interface');

    const updated = await api.patch(`/dcim/devices/${dev.id}`, { primary_ip4: ip.id });
    expect(updated.primary_ip4).toMatchObject({ id: ip.id, address: '172.16.0.10/24', display: '172.16.0.10/24' });
    expect(updated.primary_ip.id).toBe(ip.id);
    // not assigned to this device
    const wrong = await api.invalid('PATCH', `/dcim/devices/${other.id}`, { primary_ip4: ip.id });
    expect(wrong.primary_ip4[0]).toMatch(/not assigned to this device/);
    expect((await api.get(`/ipam/ip-addresses?device_id=${dev.id}`)).count).toBe(1);
    expect((await api.get(`/ipam/ip-addresses?device=r1`)).count).toBe(1);
    expect((await api.get(`/dcim/devices?has_primary_ip=true`)).count).toBe(1);

    // moving the IP elsewhere clears the primary IP
    await api.patch(`/ipam/ip-addresses/${ip.id}`, { assigned_object_id: null });
    expect((await api.get(`/dcim/devices/${dev.id}`)).primary_ip4).toBeNull();
    // deleting the device unassigns nothing remaining but works
    await api.patch(`/ipam/ip-addresses/${ip.id}`, { assigned_object_type: 'dcim.interface', assigned_object_id: eth0.id });
    await api.del(`/dcim/devices/${dev.id}`);
    expect((await api.get(`/ipam/ip-addresses/${ip.id}`)).assigned_object).toBeNull();
  });

  it('validates VLAN vids and groups', async () => {
    const { api } = await setupNetbox();
    const site = await api.post('/dcim/sites', { name: 'S', slug: 's' });
    expect((await api.invalid('POST', '/ipam/vlans', { vid: 0, name: 'x' })).vid).toBeTruthy();
    expect((await api.invalid('POST', '/ipam/vlans', { vid: 4095, name: 'x' })).vid).toBeTruthy();
    const v = await api.post('/ipam/vlans', { vid: 100, name: 'servers', site: site.id });
    expect(v.display).toBe('servers (100)');
    expect((await api.invalid('POST', '/ipam/vlans', { vid: 100, name: 'other', site: site.id })).vid[0]).toMatch(/already exists at this site/);
    await api.post('/ipam/vlans', { vid: 100, name: 'servers-global' }); // different scope
    const g = await api.post('/ipam/vlan-groups', { name: 'DC', min_vid: 100, max_vid: 199 });
    expect(g.slug).toBe('dc');
    expect((await api.invalid('POST', '/ipam/vlans', { vid: 200, name: 'out', group: g.id })).vid[0]).toMatch(/between 100 and 199/);
    await api.post('/ipam/vlans', { vid: 150, name: 'in', group: g.id });
    expect((await api.invalid('POST', '/ipam/vlans', { vid: 150, name: 'in2', group: g.id })).vid).toBeTruthy();
    expect((await api.invalid('PATCH', `/ipam/vlan-groups/${g.id}`, { max_vid: 120 })).min_vid).toBeTruthy();
    expect((await api.get(`/ipam/vlan-groups/${g.id}`)).vlan_count).toBe(1);
  });

  it('handles aggregates, RIRs and IP ranges', async () => {
    const { api } = await setupNetbox();
    const rir = await api.post('/ipam/rirs', { name: 'RFC 1918', is_private: true });
    expect(rir.slug).toBe('rfc-1918');
    await api.post('/ipam/aggregates', { prefix: '10.0.0.0/8', rir: 'rfc-1918' });
    expect((await api.invalid('POST', '/ipam/aggregates', { prefix: '10.1.0.0/16', rir: rir.id })).prefix[0]).toMatch(/overlap/);
    const range = await api.post('/ipam/ip-ranges', { start_address: '10.0.0.10/24', end_address: '10.0.0.19/24' });
    expect(range.size).toBe(10);
    expect((await api.invalid('POST', '/ipam/ip-ranges', { start_address: '10.0.0.15/24', end_address: '10.0.0.30/24' })).start_address[0]).toMatch(/overlap/);
    expect((await api.invalid('POST', '/ipam/ip-ranges', { start_address: '10.0.0.50/24', end_address: '10.0.0.40/24' })).end_address).toBeTruthy();
    const free = await api.get(`/ipam/ip-ranges/${range.id}/available-ips?limit=2`);
    expect(free.map((i: any) => i.address)).toEqual(['10.0.0.10/24', '10.0.0.11/24']);
  });
});
