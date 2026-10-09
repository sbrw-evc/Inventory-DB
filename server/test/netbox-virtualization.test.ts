import { describe, expect, it } from 'vitest';
import { seedDcim, setupNetbox } from './netbox-fixtures.js';

describe('netbox virtualization', () => {
  it('manages clusters, VMs, VM interfaces and IP assignment', async () => {
    const { api } = await setupNetbox();
    const { site, dt, role } = await seedDcim(api);
    const other = await api.post('/dcim/sites', { name: 'Other' });
    const ct = await api.post('/virtualization/cluster-types', { name: 'VMware vSphere' });
    expect(ct.slug).toBe('vmware-vsphere');
    const cg = await api.post('/virtualization/cluster-groups', { name: 'Prod' });
    const cl = await api.post('/virtualization/clusters', { name: 'esx-prod', type: ct.id, group: cg.id, site: site.id });
    expect(cl).toMatchObject({ type: { name: 'VMware vSphere' }, group: { name: 'Prod' }, status: { value: 'active' }, site: { id: site.id } });
    expect((await api.invalid('POST', '/virtualization/clusters', { name: 'ESX-PROD', type: ct.id, group: cg.id })).name).toBeTruthy();

    // devices join clusters at the same site
    const host = await api.post('/dcim/devices', { name: 'esx1', device_type: dt.id, role: role.id, site: site.id, cluster: cl.id });
    expect(host.cluster).toMatchObject({ id: cl.id, name: 'esx-prod' });
    expect((await api.invalid('POST', '/dcim/devices', { name: 'esx9', device_type: dt.id, role: role.id, site: other.id, cluster: cl.id })).cluster).toBeTruthy();

    const vmRole = await api.post('/dcim/device-roles', { name: 'App', vm_role: true });
    const noVm = await api.post('/dcim/device-roles', { name: 'Router', vm_role: false });
    const vm = await api.post('/virtualization/virtual-machines', { name: 'app-01', cluster: 'esx-prod', role: vmRole.id, vcpus: 2.5, memory: 4096, disk: 40960, device: host.id });
    expect(vm).toMatchObject({ name: 'app-01', site: { id: site.id }, cluster: { id: cl.id }, device: { id: host.id }, vcpus: 2.5, memory: 4096, status: { value: 'active' }, primary_ip: null, interface_count: 0 });
    const errs = await api.invalid('POST', '/virtualization/virtual-machines', { name: 'APP-01', cluster: cl.id, role: noVm.id, site: other.id });
    expect(errs.cluster).toBeTruthy(); // cluster at another site
    expect(errs.role).toBeTruthy();
    expect((await api.invalid('POST', '/virtualization/virtual-machines', { name: 'APP-01', cluster: cl.id })).name).toBeTruthy();
    expect((await api.invalid('POST', '/virtualization/virtual-machines', { name: 'lonely' })).cluster).toBeTruthy();
    expect((await api.invalid('POST', '/virtualization/virtual-machines', { name: 'x', vcpus: 0 })).vcpus).toBeTruthy();

    // interfaces
    const eth0 = await api.post('/virtualization/interfaces', { virtual_machine: vm.id, name: 'eth0', mtu: 1500, mac_address: '00-50-56-aa-bb-cc' });
    expect(eth0).toMatchObject({ virtual_machine: { id: vm.id, name: 'app-01' }, enabled: true, mac_address: '00:50:56:AA:BB:CC' });
    const sub = await api.post('/virtualization/interfaces', { virtual_machine: vm.id, name: 'eth0.10', parent: eth0.id });
    expect(sub.parent.id).toBe(eth0.id);
    expect((await api.invalid('POST', '/virtualization/interfaces', { virtual_machine: vm.id, name: 'ETH0' })).name).toBeTruthy();
    const vm2 = await api.post('/virtualization/virtual-machines', { name: 'app-02', cluster: cl.id });
    expect((await api.invalid('POST', '/virtualization/interfaces', { virtual_machine: vm2.id, name: 'eth0', bridge: eth0.id })).bridge).toBeTruthy();
    const vlanOther = await api.post('/ipam/vlans', { vid: 10, name: 'v10', site: other.id });
    expect((await api.invalid('PATCH', `/virtualization/interfaces/${eth0.id}`, { mode: 'access', untagged_vlan: vlanOther.id })).untagged_vlan).toBeTruthy();

    // IPs on VM interfaces, primary IP
    const ip = await api.post('/ipam/ip-addresses', { address: '10.1.0.5/24', assigned_object_type: 'virtualization.vminterface', assigned_object_id: eth0.id, dns_name: 'app-01.corp' });
    expect(ip.assigned_object_type).toBe('virtualization.vminterface');
    expect(ip.assigned_object).toMatchObject({ id: eth0.id, name: 'eth0', virtual_machine: { id: vm.id, name: 'app-01' } });
    expect((await api.invalid('POST', '/ipam/ip-addresses', { address: '10.1.0.6/24', assigned_object_type: 'dcim.site', assigned_object_id: 1 })).assigned_object_type).toBeTruthy();
    expect((await api.invalid('POST', '/ipam/ip-addresses', { address: '10.1.0.6/24', assigned_object_type: 'virtualization.vminterface', assigned_object_id: 999 })).assigned_object_id).toBeTruthy();
    // a device can't take a VM's IP as primary, the VM can
    expect((await api.invalid('PATCH', `/dcim/devices/${host.id}`, { primary_ip4: ip.id })).primary_ip4).toBeTruthy();
    const vmNow = await api.patch(`/virtualization/virtual-machines/${vm.id}`, { primary_ip4: ip.id });
    expect(vmNow.primary_ip4).toMatchObject({ id: ip.id, address: '10.1.0.5/24' });
    expect(vmNow.interface_count).toBe(2);
    expect((await api.invalid('PATCH', `/virtualization/virtual-machines/${vm2.id}`, { primary_ip4: ip.id })).primary_ip4).toBeTruthy();

    // filters
    expect((await api.get(`/ipam/ip-addresses?virtual_machine_id=${vm.id}`)).count).toBe(1);
    expect((await api.get('/ipam/ip-addresses?virtual_machine=app-01')).count).toBe(1);
    expect((await api.get(`/ipam/ip-addresses?vminterface_id=${eth0.id}`)).count).toBe(1);
    expect((await api.get('/ipam/ip-addresses?assigned_to_interface=true')).count).toBe(1);
    expect((await api.get(`/virtualization/virtual-machines?cluster_id=${cl.id}&has_primary_ip=true`)).count).toBe(1);
    expect((await api.get(`/virtualization/virtual-machines?cluster_group_id=${cg.id}`)).count).toBe(2);
    expect((await api.get(`/virtualization/interfaces?cluster_id=${cl.id}`)).count).toBe(2);
    expect((await api.get('/virtualization/virtual-machines?q=app-0')).count).toBe(2);
    expect((await api.get(`/virtualization/clusters/${cl.id}`)).virtualmachine_count).toBe(2);
    expect((await api.get(`/dcim/devices?cluster_id=${cl.id}`)).count).toBe(1);

    // moving the IP to another VM clears the primary; deleting the interface unassigns the IP
    const e2 = await api.post('/virtualization/interfaces', { virtual_machine: vm2.id, name: 'eth0' });
    await api.patch(`/ipam/ip-addresses/${ip.id}`, { assigned_object_id: e2.id });
    expect((await api.get(`/virtualization/virtual-machines/${vm.id}`)).primary_ip4).toBeNull();
    await api.del(`/virtualization/interfaces/${e2.id}`);
    expect((await api.get(`/ipam/ip-addresses/${ip.id}`)).assigned_object).toBeNull();

    // cluster with VMs is protected; deleting a VM cascades to its interfaces
    expect((await api.call('DELETE', `/virtualization/clusters/${cl.id}`)).status).toBe(409);
    await api.del(`/virtualization/virtual-machines/${vm.id}`);
    expect((await api.get(`/virtualization/interfaces?virtual_machine_id=${vm.id}`)).count).toBe(0);

    // CSV: VM interfaces and IPs by VM name
    await api.post('/netbox/import/virtualization.vminterface', { csv: 'virtual_machine,name\napp-02,eth1' });
    const csvIp = await api.post('/netbox/import/ip-addresses', { csv: 'address,virtual_machine,vminterface\n10.1.0.9/24,app-02,eth1' });
    expect(csvIp.results[0].assigned_object.virtual_machine.name).toBe('app-02');
    // change log covers the new types
    const log = await api.get(`/extras/object-changes?changed_object_type=virtualization.virtualmachine&changed_object_id=${vm.id}`);
    expect(log.results.map((r: any) => r.action.value)).toEqual(['delete', 'update', 'create']);
  });
});

describe('netbox prefix scope', () => {
  it('scopes prefixes to regions, sites and locations and keeps `site` compatible', async () => {
    const { api } = await setupNetbox();
    const { site } = await seedDcim(api);
    const region = await api.post('/dcim/regions', { name: 'EU' });
    const sub = await api.post('/dcim/regions', { name: 'DE', parent: region.id });
    await api.patch(`/dcim/sites/${site.id}`, { region: sub.id });
    const loc = await api.post('/dcim/locations', { name: 'Floor 1', site: site.id });

    const bySite = await api.post('/ipam/prefixes', { prefix: '10.0.0.0/24', site: site.id });
    expect(bySite).toMatchObject({ scope_type: 'dcim.site', scope_id: site.id, scope: { id: site.id, name: 'HQ' }, site: { id: site.id } });
    const byLoc = await api.post('/ipam/prefixes', { prefix: '10.0.1.0/24', scope_type: 'dcim.location', scope_id: loc.id });
    expect(byLoc).toMatchObject({ scope_type: 'dcim.location', scope: { id: loc.id, name: 'Floor 1' }, site: { id: site.id } });
    const byRegion = await api.post('/ipam/prefixes', { prefix: '10.1.0.0/16', scope_type: 'dcim.region', scope_id: region.id });
    expect(byRegion).toMatchObject({ scope: { id: region.id }, site: null });
    // validation
    expect((await api.invalid('POST', '/ipam/prefixes', { prefix: '10.2.0.0/24', scope_type: 'dcim.rack', scope_id: 1 })).scope_type).toBeTruthy();
    expect((await api.invalid('POST', '/ipam/prefixes', { prefix: '10.2.0.0/24', scope_type: 'dcim.site' })).scope_id).toBeTruthy();
    expect((await api.invalid('POST', '/ipam/prefixes', { prefix: '10.2.0.0/24', scope_type: 'dcim.site', scope_id: 999 })).scope_id).toBeTruthy();
    const other = await api.post('/dcim/sites', { name: 'Other' });
    expect((await api.invalid('POST', '/ipam/prefixes', { prefix: '10.2.0.0/24', site: other.id, scope_type: 'dcim.location', scope_id: loc.id })).site).toBeTruthy();

    // filters
    expect((await api.get(`/ipam/prefixes?site_id=${site.id}`)).count).toBe(2);
    expect((await api.get(`/ipam/prefixes?location_id=${loc.id}`)).count).toBe(1);
    expect((await api.get(`/ipam/prefixes?region_id=${region.id}`)).count).toBe(3); // region scope + sites in child region
    expect((await api.get('/ipam/prefixes?scope_type=dcim.region')).count).toBe(1);

    // changing `site` re-scopes; clearing the scope clears the site
    const moved = await api.patch(`/ipam/prefixes/${byLoc.id}`, { site: other.id });
    expect(moved).toMatchObject({ scope_type: 'dcim.site', scope_id: other.id });
    const cleared = await api.patch(`/ipam/prefixes/${bySite.id}`, { scope_type: null, scope_id: null });
    expect(cleared).toMatchObject({ scope: null, site: null });
    // deleting a scoped location/region clears the scope
    await api.del(`/dcim/regions/${region.id}`);
    expect((await api.get(`/ipam/prefixes/${byRegion.id}`)).scope).toBeNull();
  });
});
