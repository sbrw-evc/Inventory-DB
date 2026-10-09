/** Per object type list configuration: columns, filters, counters, and which types have a dedicated page. */

export interface TypeConfig {
  columns: string[];
  /** Filter keys sent to the API (`site_id`, `status`, `family`, `cabled`, or plain text filters like `parent`). */
  filters?: string[];
  /** Field whose choices are shown as counter tiles. */
  counters?: string;
  /** Default ordering for the list (API `ordering`). */
  ordering?: string;
  /** Has a dedicated detail page at /<app>/<path>/<id>. */
  page?: boolean;
}

export const TYPE_CONFIG: Record<string, TypeConfig> = {
  'dcim/regions': { columns: ['name', 'parent', 'site_count', 'description'], filters: ['parent_id'] },
  'dcim/sites': {
    columns: ['name', 'status', 'region', 'facility', 'tenant', 'rack_count', 'device_count', 'description', 'tags'],
    filters: ['status', 'region_id', 'tenant_id', 'tag'],
    counters: 'status',
    page: true,
  },
  'dcim/locations': { columns: ['name', 'site', 'parent', 'status', 'rack_count', 'device_count'], filters: ['site_id', 'status'] },
  'dcim/rack-roles': { columns: ['name', 'color', 'rack_count', 'description'] },
  'dcim/racks': {
    columns: ['name', 'site', 'location', 'status', 'role', 'u_height', 'device_count', '_utilization', '_power_utilization', 'tags'],
    filters: ['site_id', 'location_id', 'status', 'role_id', 'tag'],
    counters: 'status',
    page: true,
  },
  'dcim/manufacturers': { columns: ['name', 'devicetype_count', 'platform_count', 'description'] },
  'dcim/device-types': { columns: ['model', 'manufacturer', 'part_number', 'u_height', 'is_full_depth', 'interface_template_count', 'device_count'], filters: ['manufacturer_id'] },
  'dcim/interface-templates': { columns: ['device_type', 'name', 'type', 'mgmt_only', 'description'], filters: ['device_type_id', 'type'] },
  'dcim/device-roles': { columns: ['name', 'color', 'device_count', 'description'] },
  'dcim/platforms': { columns: ['name', 'manufacturer', 'device_count', 'description'], filters: ['manufacturer_id'] },
  'dcim/devices': {
    columns: ['name', 'status', 'monitoring', 'site', 'location', 'rack', 'role', 'device_type', 'primary_ip', 'serial', 'tags'],
    filters: ['site_id', 'location_id', 'rack_id', 'role_id', 'status', 'device_type_id', 'platform_id', 'cluster_id', 'tenant_id', 'tag'],
    counters: 'status',
    page: true,
  },
  'dcim/interfaces': {
    columns: ['device', 'name', 'type', 'enabled', 'lag', 'mtu', 'mac_address', 'mode', 'cable', 'link_peers', 'description'],
    filters: ['device_id', 'site_id', 'type', 'enabled', 'cabled'],
  },
  'dcim/front-ports': { columns: ['device', 'name', 'type', 'rear_port', 'rear_port_position', 'cable', 'link_peers', 'description'], filters: ['device_id', 'site_id', 'type', 'cabled'] },
  'dcim/rear-ports': { columns: ['device', 'name', 'type', 'positions', 'front_port_count', 'cable', 'link_peers', 'description'], filters: ['device_id', 'site_id', 'type', 'cabled'] },
  'dcim/power-ports': { columns: ['device', 'name', 'type', 'maximum_draw', 'allocated_draw', 'cable', 'link_peers', 'connected_endpoints'], filters: ['device_id', 'site_id', 'rack_id', 'type', 'cabled'] },
  'dcim/power-outlets': { columns: ['device', 'name', 'type', 'power_port', 'feed_leg', 'cable', 'link_peers'], filters: ['device_id', 'site_id', 'rack_id', 'feed_leg', 'cabled'] },
  'dcim/front-port-templates': { columns: ['device_type', 'name', 'type', 'rear_port', 'rear_port_position'], filters: ['device_type_id'] },
  'dcim/rear-port-templates': { columns: ['device_type', 'name', 'type', 'positions'], filters: ['device_type_id'] },
  'dcim/power-port-templates': { columns: ['device_type', 'name', 'type', 'maximum_draw', 'allocated_draw'], filters: ['device_type_id'] },
  'dcim/power-outlet-templates': { columns: ['device_type', 'name', 'type', 'power_port', 'feed_leg'], filters: ['device_type_id'] },
  'dcim/power-panels': { columns: ['name', 'site', 'location', 'powerfeed_count', 'description'], filters: ['site_id', 'location_id'] },
  'dcim/power-feeds': {
    columns: ['name', 'power_panel', 'rack', 'status', 'type', 'supply', 'phase', 'voltage', 'amperage', 'available_power', '_utilization', 'cable'],
    filters: ['power_panel_id', 'site_id', 'rack_id', 'status', 'type', 'cabled'],
    counters: 'status',
  },
  'dcim/cables': { columns: ['id', 'label', 'a_terminations', 'b_terminations', 'status', 'type', 'length', 'length_unit', 'color'], filters: ['site_id', 'device_id', 'status', 'type'], counters: 'status' },
  'ipam/vrfs': { columns: ['name', 'rd', 'tenant', 'enforce_unique', 'prefix_count', 'ipaddress_count'], filters: ['tenant_id'] },
  'ipam/route-targets': { columns: ['name', 'tenant', 'description'] },
  'ipam/rirs': { columns: ['name', 'is_private', 'aggregate_count', 'description'] },
  'ipam/aggregates': { columns: ['prefix', 'rir', '_utilization', 'tenant', 'date_added', 'description'], filters: ['rir_id', 'family'] },
  'ipam/roles': { columns: ['name', 'weight', 'prefix_count', 'vlan_count', 'description'] },
  'ipam/prefixes': {
    columns: ['prefix', 'status', '_children', 'vrf', '_utilization', 'scope', 'vlan', 'role', 'tenant', 'description'],
    filters: ['vrf_id', 'status', 'site_id', 'location_id', 'region_id', 'role_id', 'family', 'within_include', 'tag'],
    counters: 'status',
    page: true,
  },
  'ipam/ip-ranges': { columns: ['start_address', 'end_address', 'size', 'vrf', 'status', 'role', 'description'], filters: ['vrf_id', 'status', 'family'] },
  'ipam/ip-addresses': {
    columns: ['address', 'vrf', 'status', 'role', 'assigned_object', 'dns_name', 'tenant', 'description'],
    filters: ['vrf_id', 'status', 'role', 'family', 'device_id', 'virtual_machine_id', 'parent', 'tag'],
    counters: 'status',
  },
  'ipam/vlan-groups': { columns: ['name', 'site', 'min_vid', 'max_vid', 'vlan_count', 'utilization'], filters: ['site_id'] },
  'ipam/vlans': { columns: ['vid', 'name', 'site', 'group', 'status', 'role', 'tenant', 'prefix_count'], filters: ['site_id', 'group_id', 'status', 'role_id'], counters: 'status' },
  'circuits/providers': { columns: ['name', 'circuit_count', 'account_count', 'description', 'tags'] },
  'circuits/provider-accounts': { columns: ['account', 'name', 'provider', 'description'], filters: ['provider_id'] },
  'circuits/provider-networks': { columns: ['name', 'provider', 'service_id', 'description'], filters: ['provider_id'] },
  'circuits/circuit-types': { columns: ['name', 'color', 'circuit_count', 'description'] },
  'circuits/circuits': {
    columns: ['cid', 'provider', 'type', 'status', 'tenant', 'termination_a', 'termination_z', 'commit_rate', 'install_date', 'description', 'tags'],
    filters: ['provider_id', 'type_id', 'status', 'site_id', 'tenant_id', 'tag'],
    counters: 'status',
    page: true,
  },
  'circuits/circuit-terminations': { columns: ['circuit', 'term_side', 'site', 'provider_network', 'port_speed', 'xconnect_id', 'cable', 'link_peers'], filters: ['circuit_id', 'provider_id', 'site_id', 'term_side', 'cabled'] },
  'virtualization/cluster-types': { columns: ['name', 'cluster_count', 'description'] },
  'virtualization/cluster-groups': { columns: ['name', 'cluster_count', 'description'] },
  'virtualization/clusters': {
    columns: ['name', 'type', 'group', 'status', 'site', 'tenant', 'device_count', 'virtualmachine_count', 'tags'],
    filters: ['type_id', 'group_id', 'status', 'site_id', 'tenant_id', 'tag'],
    counters: 'status',
    page: true,
  },
  'virtualization/virtual-machines': {
    columns: ['name', 'status', 'site', 'cluster', 'role', 'tenant', 'vcpus', 'memory', 'disk', 'primary_ip', 'tags'],
    filters: ['cluster_id', 'site_id', 'status', 'role_id', 'platform_id', 'tenant_id', 'tag'],
    counters: 'status',
    page: true,
  },
  'virtualization/interfaces': { columns: ['virtual_machine', 'name', 'enabled', 'parent', 'mtu', 'mac_address', 'mode', 'count_ipaddresses', 'description'], filters: ['virtual_machine_id', 'cluster_id', 'enabled'] },
  'tenancy/tenant-groups': { columns: ['name', 'parent', 'tenant_count', 'description'] },
  'tenancy/tenants': { columns: ['name', 'group', 'site_count', 'device_count', 'prefix_count', 'description'], filters: ['group_id'] },
  'extras/tags': { columns: ['name', 'color', 'tagged_items', 'description'] },
  'extras/custom-fields': { columns: ['name', 'label', 'type', 'object_types', 'required', 'description'] },
  'extras/object-changes': { columns: ['time', 'user_name', 'action', 'changed_object_type', 'object_repr'], filters: ['action', 'changed_object_type'] },
};

export const configFor = (app: string, path: string): TypeConfig => TYPE_CONFIG[`${app}/${path}`] ?? { columns: ['display'] };

/** Section used in UI routes: every NetBox app is mounted at its own prefix (/dcim, /ipam, /circuits, /virtualization, /tenancy, /extras). */
export const objectRoute = (app: string, path: string, id?: number | string) => `/${app}/${path}${id != null ? `/${id}` : ''}`;
