/** Left navigation of object types, grouped like NetBox's menu. */
export const NAV: { group: string; items: string[] }[] = [
  { group: 'organization', items: ['dcim/regions', 'dcim/sites', 'dcim/locations', 'tenancy/tenants', 'tenancy/tenant-groups'] },
  { group: 'racks', items: ['dcim/racks', 'dcim/rack-roles'] },
  { group: 'devices', items: ['dcim/devices', 'dcim/device-roles', 'dcim/platforms', 'dcim/device-types', 'dcim/manufacturers', 'dcim/interface-templates'] },
  { group: 'connection', items: ['dcim/interfaces', 'dcim/cables'] },
  { group: 'ipam', items: ['ipam/prefixes', 'ipam/ip-ranges', 'ipam/ip-addresses', 'ipam/aggregates', 'ipam/rirs', 'ipam/vrfs', 'ipam/route-targets', 'ipam/roles'] },
  { group: 'vlans', items: ['ipam/vlans', 'ipam/vlan-groups'] },
  { group: 'other', items: ['extras/tags', 'extras/custom-fields', 'extras/object-changes'] },
];
