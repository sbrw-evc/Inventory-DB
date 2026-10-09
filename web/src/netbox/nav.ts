/** Left navigation of object types, grouped like NetBox's menu. */
export const NAV: { group: string; items: string[] }[] = [
  { group: 'organization', items: ['dcim/regions', 'dcim/sites', 'dcim/locations', 'tenancy/tenants', 'tenancy/tenant-groups'] },
  { group: 'racks', items: ['dcim/racks', 'dcim/rack-roles'] },
  { group: 'devices', items: ['dcim/devices', 'dcim/device-roles', 'dcim/platforms', 'dcim/device-types', 'dcim/manufacturers'] },
  { group: 'templates', items: ['dcim/interface-templates', 'dcim/front-port-templates', 'dcim/rear-port-templates', 'dcim/power-port-templates', 'dcim/power-outlet-templates'] },
  { group: 'connection', items: ['dcim/interfaces', 'dcim/front-ports', 'dcim/rear-ports', 'dcim/cables'] },
  { group: 'circuits', items: ['circuits/circuits', 'circuits/circuit-terminations', 'circuits/circuit-types', 'circuits/providers', 'circuits/provider-accounts', 'circuits/provider-networks'] },
  { group: 'power', items: ['dcim/power-panels', 'dcim/power-feeds', 'dcim/power-ports', 'dcim/power-outlets'] },
  { group: 'virtualization', items: ['virtualization/virtual-machines', 'virtualization/interfaces', 'virtualization/clusters', 'virtualization/cluster-types', 'virtualization/cluster-groups'] },
  { group: 'ipam', items: ['ipam/prefixes', 'ipam/ip-ranges', 'ipam/ip-addresses', 'ipam/aggregates', 'ipam/rirs', 'ipam/vrfs', 'ipam/route-targets', 'ipam/roles'] },
  { group: 'vlans', items: ['ipam/vlans', 'ipam/vlan-groups'] },
  { group: 'other', items: ['extras/tags', 'extras/custom-fields', 'extras/object-changes'] },
];
