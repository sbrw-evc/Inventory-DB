# DCIM / IPAM (NetBox core)

Inventory DB includes the core of NetBox: data-centre infrastructure (DCIM: sites, racks, devices, interfaces,
front/rear ports, cables, power), IP address management (IPAM), circuits and virtualization.
The REST API follows NetBox's URL layout, object shapes and filter syntax, so NetBox clients, scripts and the
Umbrella CMDB integration can use it with few or no changes.

- Server code: `server/src/netbox/` (models in `models/*.ts`, generic engine in `engine.ts`, filters in `query.ts`,
  CIDR toolkit in `cidr.ts`, IPAM/DCIM helpers in `ipam.ts`/`dcim.ts`, cables and paths in `cabling.ts`, power
  calculations in `power.ts`, routes in `routes.ts`).
- Tables: `nb_*`, created idempotently by `ensureNetboxSchema()` when the routes are registered.
- Web UI: `web/src/netbox/` (routes exported from `NetboxRoutes.tsx`).
- Tests: `server/test/netbox-*.test.ts`, `web/src/netbox/format.test.ts`.

## Access

DCIM/IPAM data is organisation-wide (not per base).

| Role | Can |
|---|---|
| (no role row) = `viewer` | read everything |
| `editor` | create, update, delete, import, allocate |
| `admin` | editor + manage roles |

- Unauthenticated requests get `401`; writes without the editor role get `403`.
- Bootstrap: while nobody is admin, the first signed-in user who calls `GET /api/v1/netbox/me` or any write endpoint becomes admin.
- Auth is the same as the rest of the API: `Authorization: Bearer <jwt>`, `xc-auth`, or `xc-token: <api token>`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/netbox/me` | `{user, role, can_write, is_admin}` |
| GET | `/api/v1/netbox/roles` | admin; `{results: [{user_id, email, name, role}]}` (all users) |
| POST | `/api/v1/netbox/roles` | admin; `{email | user_id, role}` |
| PUT | `/api/v1/netbox/roles/:userId` | admin; `{role}`. The last admin can't be demoted (`409`). |

## Conventions

### Object shape

Every object has:

```json
{
  "id": 12,
  "url": "/api/v1/dcim/devices/12/",
  "display_url": "/dcim/devices/12",
  "display": "sw-core-1",
  "...fields": "...",
  "tags": [{ "id": 1, "url": "/api/v1/extras/tags/1/", "display": "Core", "name": "Core", "slug": "core", "color": "b85450" }],
  "custom_fields": { "rack_power": 42 },
  "created": "2026-10-08T12:00:00.000Z",
  "last_updated": "2026-10-08T12:00:00.000Z"
}
```

(`tags` and `custom_fields` are absent on tags, custom fields, component templates and change-log entries.)

- **References** are nested objects `{id, url, display, ...brief fields}`, e.g. a site is `{id, url, display, name, slug}`.
  One more level is nested where useful (a device type's `manufacturer`, an interface's `device`).
- **Choice fields** (status, type, face, mode, role on IPs, …) are `{"value": "active", "label": "Active"}`. Input accepts the
  plain value (`"active"`), the `{value}` object, or the label.
- **Family** on prefixes/aggregates/IPs/ranges is `{"value": 4, "label": "IPv4"}`.
- Colours are 6-digit lowercase hex without `#` (input with `#` is accepted).
- `url` is the API path (relative to the server); `display_url` is the UI route.
- Trailing slashes are optional (`/api/v1/dcim/devices/` and `/api/v1/dcim/devices` are the same).

### Writing

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/<app>/<type>/` | object, or list of objects (bulk) | `201` object / list |
| PATCH or PUT | `/<app>/<type>/:id/` | partial object | object |
| PATCH or PUT | `/<app>/<type>/` | list of objects each with `id` (bulk) | list |
| DELETE | `/<app>/<type>/:id/` | | `204` |
| DELETE | `/<app>/<type>/` | `[{id}, …]`, `[id, …]` or `{ids: […]}` (bulk) | `204` |

- References may be given as an id, `{id}`, `{slug}`/`{name}`, or a slug/name string (`"site": "hq"`).
- `tags`: list of tag ids, slugs, or `{name}`/`{slug}` objects. Replaces the object's tags.
- `custom_fields`: object of values; merged into the existing values on update; unknown names are rejected.
- `slug` is generated from `name` (or `model`) when omitted.
- Unknown and read-only fields are ignored (NetBox behaviour), so a fetched object can be sent back.
- Bulk requests run in one transaction: any failure rolls back the whole request.
- Validation errors: `400 {"error": "BAD_REQUEST", "message": "Validation failed", "details": {"field": ["message", …]}}`.
- Deleting an object that others depend on returns `409` with the dependants named (e.g. a site with racks).
  Owned objects cascade: a device's interfaces, a device type's interface templates, a site's locations and VLAN groups,
  child regions/locations/tenant groups. Optional references are cleared (e.g. a rack role, a device's primary IP).
  Deleting an interface also deletes its cable and unassigns its IP addresses.

### Listing

`GET /<app>/<type>/` returns `{count, next, previous, results}`.

| Parameter | Meaning |
|---|---|
| `limit`, `offset` | Paging; default `limit=50`, max 1000; `limit=0` means the max. `next`/`previous` are relative URLs. |
| `q` | Text search over the type's name-like fields (plus numeric id). For prefixes/IPs an address finds the containing prefixes / the exact IP. |
| `ordering` | Comma-separated fields, `-` for descending (`ordering=-name`, `ordering=site,name`). Reference fields sort by the related name. |
| `brief=1` | Results as nested references only (for pickers). |
| `<field>=v` | Exact match on scalar/choice fields (`status=active`, `vid=10`, `name=sw1`). Repeat the key for OR (`status=active&status=planned`). |
| `<ref>_id=n` | By related id (`site_id=1`, `rack_id=3`). `null` matches empty (`vrf_id=null`). |
| `<ref>=slug` | By related slug, or name when the type has no slug (`site=hq`, `device=sw1`, `vrf=red`). |
| `tag=slug` | Has the tag (repeat to require several); `tag__n=slug` hasn't; `tag_id=n`. |
| `cf_<name>=v` | Custom field value (supports lookups, e.g. `cf_rack_power__gte=40`). |
| Lookups | Append to a field filter: `__n` (not), `__ic` / `__nic` (contains / not, case-insensitive), `__isw`, `__iew`, `__ie`, `__gte`, `__lte`, `__gt`, `__lt`, `__empty=true`. Also on `id`, `created`, `last_updated`. |

Unknown filter names return `400` (so typos don't silently return everything).

Type-specific filters are listed with each type below.

## Endpoints

All paths below are under `/api/v1`. "Computed" fields are read-only.

### DCIM — `/dcim/…`

| Path | Fields | Computed | Extra filters |
|---|---|---|---|
| `regions` | name, slug, parent, description | `_depth`, site_count | |
| `sites` | name, slug, status (planned/staging/active/decommissioning/retired), region, tenant, facility, time_zone, description, physical_address, shipping_address, latitude, longitude, comments | location_count, rack_count, device_count, prefix_count, vlan_count | `region_id` includes child regions |
| `locations` | name, slug, site, parent, status, tenant, description | `_depth`, rack_count, device_count | |
| `rack-roles` | name, slug, color, description | rack_count | |
| `racks` | name, facility_id, site, location, tenant, status (reserved/available/planned/active/deprecated), role, serial, asset_tag, form_factor, width (10/19/21/23), u_height (default 42), desc_units, description, comments | device_count, powerfeed_count, `_utilization` (% units used), `_power_utilization` (% of feed power allocated) | |
| `manufacturers` | name, slug, description | devicetype_count, platform_count | |
| `device-types` | manufacturer, model, slug, part_number, u_height, is_full_depth, description, comments | device_count, interface_template_count, front_port_template_count, rear_port_template_count, power_port_template_count, power_outlet_template_count | |
| `interface-templates` | device_type, name, label, type, enabled, mgmt_only, description | | |
| `rear-port-templates` | device_type, name, label, type, color, positions (1-1024), description | | |
| `front-port-templates` | device_type, name, label, type, color, rear_port (template), rear_port_position, description | | |
| `power-port-templates` | device_type, name, label, type, maximum_draw, allocated_draw (W), description | | |
| `power-outlet-templates` | device_type, name, label, type, power_port (template), feed_leg (A/B/C), description | | |
| `device-roles` | name, slug, color, vm_role, description | device_count | |
| `platforms` | name, slug, manufacturer, description | device_count | |
| `devices` | name, device_type, role, tenant, platform, serial, asset_tag, site, location, rack, cluster, position, face (front/rear), status (offline/active/planned/staged/failed/inventory/decommissioning), primary_ip4, primary_ip6, description, comments | primary_ip, interface_count, front_port_count, rear_port_count, power_port_count, power_outlet_count, u_height | `has_primary_ip`, `manufacturer_id` |
| `interfaces` | device, name, label, type, enabled, parent, lag, mtu, mac_address, speed, mgmt_only, description, mode (access/tagged/tagged-all), untagged_vlan, tagged_vlans, mark_connected | cable, cable_end, link_peers, link_peers_type, connected_endpoints, connected_endpoints_type, connected_endpoints_reachable, `_occupied`, count_ipaddresses | `site_id`, `rack_id`, `role_id` (of the device), `cabled`, `vlan_id` (untagged or tagged) |
| `rear-ports` | device, name, label, type, color, positions (1-1024), description, mark_connected | cable, cable_end, link_peers…, `_occupied`, front_port_count | `site_id`, `rack_id`, `role_id`, `cabled` |
| `front-ports` | device, name, label, type, color, rear_port, rear_port_position, description, mark_connected | cable, cable_end, link_peers…, `_occupied` | as rear ports |
| `power-ports` | device, name, label, type, maximum_draw, allocated_draw (W), description, mark_connected | cable, cable_end, link_peers…, `_occupied`, `_power_draw` `{allocated, maximum, outlet_count, connected}` | as rear ports |
| `power-outlets` | device, name, label, type, power_port, feed_leg (A/B/C), description, mark_connected | cable, cable_end, link_peers…, `_occupied` | as rear ports |
| `power-panels` | site, location, name, description, comments | powerfeed_count | |
| `power-feeds` | power_panel, rack, name, status (offline/active/planned/failed), type (primary/redundant), supply (ac/dc), phase (single-phase/three-phase), voltage (default 230), amperage (default 16), max_utilization (%, default 80), tenant, description, comments, mark_connected | site, available_power (VA), allocated_draw, maximum_draw, `_utilization`, cable, link_peers…, `_occupied` | `site_id`, `cabled` |
| `cables` | a_terminations, b_terminations, type, status (connected/planned/decommissioning), tenant, label, color, length, length_unit, description, comments | | `device_id`, `rack_id`, `site_id`, `circuit_id`, `interface_id`, `frontport_id`, `rearport_id`, `powerport_id`, `poweroutlet_id`, `powerfeed_id`, `circuittermination_id`, `termination_type` (e.g. `dcim.powerfeed`) |

"link_peers…" means the connection fields every cable termination has (interfaces, front/rear ports, power ports,
outlets and feeds, circuit terminations): `link_peers` (the objects on the far end of its own cable) and
`link_peers_type`, `connected_endpoints` / `connected_endpoints_type` (the end of the whole path, through patch panels
and circuits; `null` while the path is incomplete) and `connected_endpoints_reachable` (every cable on the path is
`connected`).

Port types (front/rear): `8p8c`, `8p6c`, `110-punch`, `bnc`, `f`, `n`, `mrj21`, `fc`, `lc`, `lc-pc`, `lc-upc`, `lc-apc`,
`lsh`, `mpo`, `mtrj`, `sc`, `sc-pc`, `sc-upc`, `sc-apc`, `st`, `cs`, `sn`, `splice`, `other`. Power port types include
`iec-60320-c14`, `iec-60320-c20`, `iec-60309-p-n-e-6h`, `nema-5-15p`, `cee-7-7`, `dc-terminal`, `hardwired`; outlet types
`iec-60320-c13`, `iec-60320-c19`, `nema-5-15r`, `cee-7-3`, … (full lists in `/netbox/schema`).

Interface types: `virtual`, `bridge`, `lag`, `100base-tx`, `1000base-t`, `2.5gbase-t`, `5gbase-t`, `10gbase-t`, `1000base-x-sfp`,
`10gbase-x-sfpp`, `25gbase-x-sfp28`, `40gbase-x-qsfpp`, `100gbase-x-qsfp28`, `400gbase-x-qsfpdd`, `ieee802.11ac`, `ieee802.11ax`, `other`.

Rules:
- Device names are unique per site and tenant (case-insensitive). Asset tags are unique.
- Rack, location and rack-location must belong to the device's site; the location is taken from the rack when omitted.
- `position` needs a rack and a face; the device (device type `u_height`) must fit in the rack and must not overlap a
  device on the same face. Full-depth device types occupy both faces. 0U device types can't take a position.
  Racks can't shrink below installed devices; device types can't grow if a racked device would stop fitting.
- Creating a device copies its device type's templates into components: interfaces, rear ports, front ports (mapped
  to the new rear ports), power ports and power outlets (mapped to the new power ports).
- A device's `cluster` must be at the device's site when the cluster has a site.
- Components can't move to another device; names are unique per device. A front port's rear port must be on the same
  device, `rear_port_position` must be ≤ the rear port's `positions` and unique per rear port; a rear port can't get
  fewer positions than its mapped front ports. `allocated_draw` can't exceed `maximum_draw`. A power outlet's
  `power_port` must be on the same device. The same rules apply to templates within a device type.
- Power feeds: the rack must be at the panel's site; DC can't be three-phase; AC voltage can't be negative; names are
  unique per panel. `available_power` = voltage × amperage × max_utilization %, × √3 for three-phase AC (NetBox formula).
- Power draw: a power port that feeds outlets (a PDU inlet) draws the sum of the ports plugged into those outlets;
  other ports draw their own `allocated_draw`/`maximum_draw`. A feed's load is the draw of the power ports cabled to it;
  a rack's `_power_utilization` is the allocated draw on its feeds over their available power.
- `primary_ip4`/`primary_ip6` must be an IP of that family assigned to one of the device's interfaces. Moving the IP
  to another device clears it.
- LAG members must be on the same device and the LAG interface must have type `lag`. VLAN modes: `untagged_vlan` needs
  a mode, `tagged_vlans` only with `tagged` (cleared otherwise). VLANs with a site must match the device's site.
- Cables: each side is a list of `{"object_type": "...", "object_id": n}` (bare ids mean interfaces). Types:
  `dcim.interface`, `dcim.frontport`, `dcim.rearport`, `circuits.circuittermination`, `dcim.powerport`,
  `dcim.poweroutlet`, `dcim.powerfeed`. All terminations on a side have the same type and parent (device / circuit /
  panel). Compatible pairs follow NetBox: interfaces, front/rear ports and circuit terminations connect to each other;
  power ports to power outlets or power feeds. A termination can be on one cable only; virtual/bridge/LAG interfaces and
  circuit terminations on a provider network can't be cabled; `length` needs `length_unit`. Deleting a termination
  deletes its cable.
- Paths: from a front port the path continues at its rear port; from a rear port with several positions it returns to
  the front port at the position it entered with (a stack, so nested trunks work); a circuit termination continues at
  the circuit's other termination. A rear port reached without a position (e.g. tracing from the rear port itself)
  ends the path, as in NetBox.

Special endpoints:

| Method | Path | Returns |
|---|---|---|
| GET | `/dcim/racks/:id/elevation?face=front\|rear` | `{count, next, previous, results}` of units top-down (bottom-up with `desc_units`): `{id, name: "U42", face, occupied, device}`; `device` is the device reference plus `position`, `u_height`, `face`, `is_full_depth`, `role`, `role_color`, `status` |
| GET | `/dcim/racks/:id/power` | `{feeds: [{feed, status, type, available_power, allocated_draw, maximum_draw, utilization}], available_power, allocated_draw, maximum_draw, utilization, device_power_ports, device_allocated_draw, device_maximum_draw}` (device_* = end-consumer ports of devices in the rack) |
| GET | `/dcim/{interfaces,front-ports,rear-ports,power-ports,power-outlets,power-feeds}/:id/trace`, `/circuits/circuit-terminations/:id/trace` | Cable path as NetBox segments `[[near_ends[], cable, far_ends[]], …]` (full serialized objects), one segment per cable; `[]` when not cabled. A path that stops at an uncabled pass-through port ends with `[[port], null, []]`. Front/rear ports and circuit terminations also answer at `…/:id/paths`. |

### IPAM — `/ipam/…`

| Path | Fields | Computed | Extra filters |
|---|---|---|---|
| `vrfs` | name, rd, tenant, enforce_unique (default true), import_targets, export_targets, description, comments | ipaddress_count, prefix_count | |
| `route-targets` | name, tenant, description, comments | | |
| `rirs` | name, slug, is_private, description | aggregate_count | |
| `aggregates` | prefix, rir, tenant, date_added, description, comments | family, `_utilization` | `family`, `prefix` (within) |
| `roles` | name, slug, weight, description | prefix_count, vlan_count | |
| `prefixes` | prefix, vrf, scope_type, scope_id, site, tenant, vlan, status (container/active/reserved/deprecated), role, is_pool, mark_utilized, description, comments | family, scope, `_depth`, `_children`, `_utilization` | `family`, `mask_length` (`__gte`, `__lte`), `within`, `parent` (same as within: strictly inside), `within_include`, `contains` (prefix or IP), `depth`, `location_id`, `region_id` (region scope in the subtree, or a site in it) |
| `ip-ranges` | start_address, end_address, vrf, tenant, status, role, mark_populated, mark_utilized, description, comments | family, size | `family`, `parent` |
| `ip-addresses` | address, vrf, tenant, status (active/reserved/deprecated/dhcp/slaac), role (loopback/secondary/anycast/vip/vrrp/hsrp/glbp/carp), assigned_object_type, assigned_object_id, nat_inside, dns_name, description, comments | family, assigned_object | `family`, `mask_length`, `parent` (prefix), `interface_id`, `device_id`, `device` (name), `site_id`, `vminterface_id`, `virtual_machine_id`, `virtual_machine` (name), `assigned_to_interface` (device or VM interface) |
| `vlan-groups` | name, slug, site, min_vid, max_vid, description | vlan_count, utilization | |
| `vlans` | site, group, vid (1-4094), name, tenant, status, role, description, comments | prefix_count | |

Rules:
- IPv4 and IPv6 everywhere. Prefixes are normalised to the network (`10.0.0.5/24` → `10.0.0.0/24`), addresses keep
  their mask (`10.0.0.5/24`; no mask means /32 or /128). IPv6 output uses RFC 5952 compression.
- Hierarchy: `_depth` / `_children` count strict parents/children in the same VRF. Lists ordered by `prefix` (the default)
  sort by VRF, family and network, so `_depth` gives a tree.
- Utilisation: containers count the space covered by child prefixes; other prefixes count IP addresses and IP ranges
  marked utilised against the usable hosts (IPv4 networks larger than /31 exclude network and broadcast unless
  `is_pool`; IPv6 excludes the subnet-router anycast address). `mark_utilized` means 100%. Values are percent with one decimal.
- A global (no VRF) container prefix spans all VRFs for utilisation and availability, as in NetBox; otherwise children are
  in the same VRF.
- Uniqueness: prefixes and IP addresses are unique within the global table and within VRFs with `enforce_unique`;
  IP uniqueness compares the host address (mask ignored) and skips the shared roles anycast/vip/vrrp/hsrp/glbp/carp.
  Aggregates may not overlap; IP ranges may not overlap within a VRF; range ends must share family and mask.
- VLAN `vid` is 1–4094 and within its group's `min_vid`–`max_vid`; unique per group (and name unique per group);
  without a group, unique per site (or globally when there's no site).
- IP assignment: `assigned_object_type` is `"dcim.interface"` (defaulted when only `assigned_object_id` is given) or
  `"virtualization.vminterface"`, with `assigned_object_id`. `assigned_object` is
  `{id, url, display, name, device: {id, url, display, name}, cable}` for device interfaces and
  `{id, url, display, name, virtual_machine: {id, url, display, name}}` for VM interfaces. Moving an IP away clears it
  as the old device's/VM's primary IP.
- Prefix scope (NetBox 4): `scope_type` is `dcim.region`, `dcim.site` or `dcim.location`, with `scope_id`; `scope` is the
  nested object. `site` stays for compatibility: writing `site` scopes the prefix to that site, a site or location scope
  fills `site` (a region scope clears it), giving both must agree, and clearing the scope clears `site`. Prefixes created
  before scopes existed are scoped to their site at startup. Deleting a scoped region/location clears the scope.

Allocation endpoints (NetBox compatible):

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/ipam/prefixes/:id/available-prefixes` | | `[{family, prefix, vrf}]`, free space as aligned CIDR blocks |
| POST | `/ipam/prefixes/:id/available-prefixes` | `{prefix_length, ...prefix fields}` or a list | `201` created prefix(es) in the parent's VRF; `409` when there is no room |
| GET | `/ipam/prefixes/:id/available-ips` | `?limit=` (default 50, max 1000) | `[{family, address, vrf}]` |
| POST | `/ipam/prefixes/:id/available-ips` | `{...ip fields}` or a list (one IP per item) | `201` created IP(s) with the prefix mask; `409` when full |
| GET/POST | `/ipam/ip-ranges/:id/available-ips` | as above, within the range | |

Available IPs skip existing IPs (same VRF) and IP ranges marked `mark_populated`.

### Circuits — `/circuits/…`

| Path | Fields | Computed | Extra filters |
|---|---|---|---|
| `providers` | name, slug, description, comments | circuit_count, account_count | |
| `provider-accounts` | provider, account, name, description, comments | | |
| `provider-networks` | provider, name, service_id, description, comments | | |
| `circuit-types` | name, slug, color, description | circuit_count | |
| `circuits` | cid, provider, provider_account, type, status (planned/provisioning/active/offline/deprovisioning/decommissioned), tenant, install_date, termination_date, commit_rate (Kbps), description, comments | termination_a, termination_z (`{id, url, display, site, provider_network, port_speed, upstream_speed, xconnect_id, description, cable}`) | `site_id`, `provider_network_id` (of a termination) |
| `circuit-terminations` | circuit, term_side (A/Z), site, provider_network, port_speed, upstream_speed (Kbps), xconnect_id, pp_info, description, mark_connected | cable, cable_end, link_peers… , `_occupied` | `provider_id`, `cabled` |

Rules: `cid` is unique per provider; account unique per provider (and name, when set); provider networks unique by
name per provider; `provider_account` must belong to the provider; `termination_date` ≥ `install_date`. A circuit has
at most one A and one Z termination, each attached to exactly one of `site` or `provider_network`; terminations can't
move to another circuit and are deleted with it. Providers, types and sites in use are protected. References to a
circuit accept its `cid` (`"circuit": "CID-1"`).

### Virtualization — `/virtualization/…`

| Path | Fields | Computed | Extra filters |
|---|---|---|---|
| `cluster-types` | name, slug, description | cluster_count | |
| `cluster-groups` | name, slug, description | cluster_count | |
| `clusters` | name, type, group, status (planned/staging/active/decommissioning/offline), tenant, site, description, comments | device_count, virtualmachine_count | |
| `virtual-machines` | name, status (offline/active/planned/staged/failed/decommissioning), site, cluster, device (host), role, tenant, platform, primary_ip4, primary_ip6, vcpus, memory (MB), disk (MB), serial, description, comments | primary_ip, interface_count | `has_primary_ip`, `cluster_group_id`, `cluster_type_id` |
| `interfaces` (VM interfaces, `virtualization.vminterface`) | virtual_machine, name, enabled, parent, bridge, mtu, mac_address, description, mode, untagged_vlan, tagged_vlans, vrf | count_ipaddresses | `cluster_id`, `vlan_id` |

Rules: cluster names are unique within their group, within their site, or globally when they have neither; a cluster
can't move to another site while its devices/VMs are elsewhere. A VM needs a site or cluster; the site comes from the
cluster when omitted and must match it; the host `device` must be in the VM's cluster; the role must have `vm_role`;
names are unique (case-insensitive) per cluster and tenant (per site without a cluster). VM primary IPs must be
assigned to the VM's interfaces. VM interface parent/bridge must be on the same VM; VLANs must be global or at the
VM's site. Deleting a VM deletes its interfaces; deleting a VM interface unassigns its IPs. Clusters with VMs are
protected; deleting a cluster clears `cluster` on its devices.

### Tenancy and extras

| Path | Fields | Computed |
|---|---|---|
| `/tenancy/tenant-groups` | name, slug, parent, description | `_depth`, tenant_count |
| `/tenancy/tenants` | name, slug, group, description, comments | site_count, device_count, prefix_count, ipaddress_count |
| `/extras/tags` | name, slug, color, description | tagged_items |
| `/extras/custom-fields` | object_types (e.g. `["dcim.device"]`), type (text/longtext/integer/decimal/boolean/date/url/select/multiselect/json), name (`[a-z0-9_]`), label, description, required, default, weight, choices (select types), validation_minimum, validation_maximum, validation_regex | |
| `/extras/object-changes` (alias `/extras/changelog`) | read-only: time, user_id, user_name, request_id, action (create/update/delete), changed_object_type, changed_object_id, object_repr, prechange_data, postchange_data | |

Every create, update and delete (including cascades and bulk/import rows) is written to the change log inside the same
transaction, with full serialized snapshots before and after. Filter with `changed_object_type`, `changed_object_id`,
`action`, `user_id`; default ordering is newest first.

### Other endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/netbox/search?q=&limit=10&object_type=dcim.device,ipam.prefix` | Global search: `{count, results: [{object_type, object_type_label, id, url, display, display_url, ...brief}]}` |
| GET | `/netbox/schema` | Model metadata for clients/UI: object types, paths, fields (kind, required, choices, ref), filters |
| POST | `/netbox/import/:objectType` | CSV bulk import (below) |

## CSV import

`POST /api/v1/netbox/import/:objectType` where `:objectType` is `dcim.device`, `devices` or `dcim/devices`.
Body: CSV text with `Content-Type: text/csv`, or JSON `{"csv": "..."}`.

- Header row = field names. References by id, slug or name (`site=hq`, `device_type=C9300-48P`).
- `tags`: comma-separated slugs. `cf_<name>`: custom field values. m2m fields: comma-separated.
- Scoped names: devices resolve `rack`/`location` within the row's site; interfaces resolve `lag`/`parent` within the
  row's device; front ports resolve `rear_port` and power outlets `power_port` within the row's device; VM interfaces
  resolve `parent`/`bridge` within the row's `virtual_machine`; IP addresses take `device` + `interface` (or
  `virtual_machine` + `vminterface`) and are assigned to that interface; power feeds resolve `power_panel` within `site`
  (when given) and `rack` within the panel's site; circuit terminations take `circuit` by cid.
- Cables take `side_a_type` (default `dcim.interface`; any termination type), `side_a_device`, `side_a_name` and the
  same for side B. For circuit terminations use `side_a_circuit` (cid) and `side_a_name` = `A`/`Z`; for power feeds
  `side_a_power_panel` (optional) and the feed name.
- All rows are created in one transaction. If any row fails, nothing is imported and the response is
  `400 {"details": [{"row": 2, "errors": {"device_type": ["…"]}}]}` (row numbers are 1-based data rows).
- Success: `201 {"created": n, "results": [objects]}`.

```csv
name,device_type,role,site,rack,position,face,status,tags
sw-01,C9300-48P,access-switch,hq,R101,40,front,active,core
```

## Events (integrations, webhooks)

`server/src/netbox/events.ts` exports `netboxEvents` (a Node `EventEmitter`) that emits after the transaction commits:

| Event | Payload |
|---|---|
| `object.created` | `{objectType, id, data, userId}` (`data` = serialized object) |
| `object.updated` | same, post-change data |
| `object.deleted` | same, pre-change data |

```ts
import { netboxEvents } from './netbox/events.js';
netboxEvents.on('object.updated', ({ objectType, id, data }) => { /* sync to Umbrella CMDB */ });
```

## Umbrella integration contract

The Umbrella monitoring integration reads devices, interfaces, IP addresses, sites, racks and cables from this API.
These shapes are stable:

- Lists: `GET /api/v1/dcim/{sites,racks,devices,interfaces,cables}/`, `GET /api/v1/ipam/ip-addresses/` with
  `limit`/`offset` → `{count, next, previous, results}`.
- Device:
  ```json
  {
    "id": 3, "url": "/api/v1/dcim/devices/3/", "display": "esx-01", "name": "esx-01",
    "status": { "value": "active", "label": "Active" },
    "role": { "id": 2, "url": "/api/v1/dcim/device-roles/2/", "display": "Server", "name": "Server", "slug": "server", "color": "82b366" },
    "device_type": { "id": 2, "url": "…", "display": "UCS C240", "model": "UCS C240", "slug": "ucs-c240",
                     "manufacturer": { "id": 1, "url": "…", "display": "Cisco", "name": "Cisco", "slug": "cisco" } },
    "site": { "id": 1, "url": "…", "display": "HQ", "name": "HQ", "slug": "hq" },
    "rack": { "id": 1, "url": "…", "display": "R101", "name": "R101" },
    "primary_ip4": { "id": 7, "url": "…", "display": "10.0.10.1/24", "address": "10.0.10.1/24" },
    "primary_ip": { "…": "same as primary_ip4 (or primary_ip6)" },
    "serial": "FCW1234", "tags": [{ "id": 1, "name": "Core", "slug": "core", "color": "b85450", "url": "…", "display": "Core" }],
    "last_updated": "2026-10-08T12:00:00.000Z"
  }
  ```
- IP address: `assigned_object_type: "dcim.interface"`, `assigned_object_id`, `assigned_object: {id, url, display, name, device: {id, url, display, name}, cable}`.
- Cable: `a_terminations` / `b_terminations` = `[{object_type: "dcim.interface", object_id, object: {id, url, display, name, device: {id, url, display, name}, cable}}]`.
  Cables may now also end on front/rear ports and power ports/outlets (same `object.device` shape), power feeds
  (`object.power_panel` instead of `device`) and circuit terminations (`object.circuit`); consumers that only want
  device-to-device links can keep reading `object.device.id` and skip ends without it.
- IP addresses on VM interfaces have `assigned_object_type: "virtualization.vminterface"` and
  `assigned_object.virtual_machine` instead of `assigned_object.device`. Devices gained a `cluster` reference.

**Monitoring status in the UI.** The device list (column "Monitoring") and the device page (chip next to the status)
call `GET /api/v1/integrations/umbrella/status?object_type=dcim.device&ids=1,2,3`, served by the integration module.
Accepted response shapes (any of):

```json
{ "results": { "1": { "status": "critical", "open_alerts": 2, "incident_url": "https://umbrella/incidents/42" } } }
{ "results": [ { "object_id": 1, "status": "ok", "open_alerts": 0, "incident_url": null } ] }
```

`status` is one of `ok | info | warning | error | critical` (shown with the design's chip colours); the chip links to
`incident_url` when present. Any error (e.g. `404` when the integration isn't installed) hides the column/chip.

## Web UI

`web/src/netbox/NetboxRoutes.tsx` exports `DcimRoutes`, `IpamRoutes`, `CircuitsRoutes`, `VirtualizationRoutes`,
`TenancyRoutes`, `ExtrasRoutes` and `NetboxRoutes`. Mount them in the main router (react-router-dom v7):

```tsx
<Route path="/dcim/*" element={<DcimRoutes />} />
<Route path="/ipam/*" element={<IpamRoutes />} />
<Route path="/circuits/*" element={<CircuitsRoutes />} />
<Route path="/virtualization/*" element={<VirtualizationRoutes />} />
<Route path="/tenancy/*" element={<TenancyRoutes />} />
<Route path="/extras/*" element={<ExtrasRoutes />} />
```

The left navigation groups types like NetBox's menu: Organization, Racks, Devices, Component templates, Connections
(interfaces, front/rear ports, cables), Circuits, Power, Virtualization, IPAM, VLANs, Other.

Pages (styled per `docs/design.md`; the navy header comes from the main layout):

| Route | Page |
|---|---|
| `/dcim`, `/ipam`, `/circuits`, `/virtualization` | Section overview with counters per type |
| `/circuits/circuits/:id` | Circuit details and the A/Z terminations (site or provider network, speeds, cross-connect, cable, connected endpoint, trace link; "Add termination" when missing) |
| `/virtualization/clusters/:id` | Cluster details, host devices, virtual machines |
| `/virtualization/virtual-machines/:id` | VM details, IP addresses, interfaces with their IPs |
| `/<app>/<type>/:id/trace` | Cable trace of any termination (interfaces, front/rear ports, power ports/outlets/feeds, circuit terminations), one row per cable through patch panels and circuits |
| `/<app>/<type>` | Generic list: left type navigation, toolbar (search, Add, Import CSV, Export CSV, Copy link with filters, live-update indicator), filter row (`Field: value ▾`, kept in the URL), status counters, bulk bar (Selected: N · Delete), table with gray header, sortable columns and status chips, paging; right side panel with Details · Edit · History tabs (`?_sel=<id>`, `?_sel=new`, `?_sel=import`) |
| `/<app>/<type>/<id>` | Dedicated page for sites, racks, devices, prefixes, circuits, clusters and VMs; for other types the list with the panel open |
| `/dcim/sites/:id` | Site counters (locations, racks, devices, prefixes, VLANs), details, racks and devices |
| `/dcim/racks/:id` | Front and rear SVG elevation (devices coloured by role colour, click → device), devices without a position, power utilisation card (feeds with capacity, allocated draw and bars) |
| `/dcim/devices/:id` | Details (incl. cluster), monitoring chip, IP addresses, interfaces with IPs, cable (→ trace) and connected endpoint; front ports, rear ports, power ports and power outlets cards when the device has them |
| `/ipam/prefixes/:id` | Details and utilisation bar, child prefix tree with available blocks, next available IP / allocate prefix, child IPs |
| `/dcim/search?q=` | Global DCIM/IPAM search |

The prefix list is a tree (indentation by `_depth`) with utilisation bars and a Scope column. The cable form picks a
termination type per side (interface, front/rear port, circuit termination, power port/outlet/feed); the IP address
form picks a device interface or a VM interface.

- API client: `web/src/netbox/api.ts`, reads the JWT from `localStorage.token`.
- Strings: `web/src/netbox/i18n.ts`, English and Russian; the language comes from `localStorage.lang` (`en` default).
- Actions the user's role can't perform (Add, Import, Edit, Delete) are hidden; the API enforces permissions anyway.
