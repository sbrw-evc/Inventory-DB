import type { InventoryObjectType, UmbrellaCi } from '../../../../shared/src/index.js';
import type { DcimClient, NetboxObject } from '../dcim.js';

export const SOURCE = 'inventory-db';

export const sourceRef = (type: InventoryObjectType, id: number) => `${SOURCE}:${type}:${id}`;

const REF_RE = /^inventory-db:(dcim\.(?:site|rack|device)):(\d+)$/;

export function parseSourceRef(ref: string): { type: InventoryObjectType; id: number } | null {
  const m = REF_RE.exec(ref);
  return m ? { type: m[1] as InventoryObjectType, id: Number(m[2]) } : null;
}

/** Lifecycle statuses where an alert means a real problem; other statuses must not page anyone. */
const MONITORED_STATUSES = new Set(['active', 'staged', 'staging', 'failed']);

/** NetBox serialises choices as `{value, label}` and nested objects as `{id, name, slug, ...}`. */
const choice = (v: unknown): string | null =>
  v == null ? null : typeof v === 'object' ? ((v as any).value ?? (v as any).slug ?? (v as any).name ?? null) : String(v);
const name = (v: unknown): string | null => (v && typeof v === 'object' ? ((v as any).name ?? (v as any).display ?? null) : null);
const stripMask = (address: string) => address.split('/')[0];
const tags = (o: NetboxObject): string[] => (Array.isArray(o.tags) ? o.tags.map((t: any) => t?.slug ?? t?.name ?? String(t)) : []);

const PATHS: Record<InventoryObjectType, string> = { 'dcim.site': 'dcim/sites', 'dcim.rack': 'dcim/racks', 'dcim.device': 'dcim/devices' };

function link(baseUrl: string, type: InventoryObjectType, o: NetboxObject): string {
  const display = typeof o.display_url === 'string' ? o.display_url : null;
  if (display && /^https?:\/\//.test(display)) return display;
  if (display?.startsWith('/')) return `${baseUrl}${display}`;
  return `${baseUrl}/${PATHS[type]}/${o.id}`;
}

function base(type: InventoryObjectType, o: NetboxObject, baseUrl: string) {
  const status = choice(o.status) ?? 'active';
  return {
    source_ref: sourceRef(type, o.id),
    name: String(o.name ?? o.display ?? `${type} ${o.id}`),
    status,
    monitored: MONITORED_STATUSES.has(status),
    url: link(baseUrl, type, o),
    last_updated: (o.last_updated as string | undefined) ?? null,
  };
}

/**
 * Builds the CMDB feed: sites, racks and devices as configuration items with identities (names, IPs,
 * DNS names, serials) for alert matching and relations (located_in, connected_to) for impact analysis.
 */
export async function buildCis(client: DcimClient, baseUrl: string): Promise<UmbrellaCi[]> {
  const [sites, racks, devices, ips, cables] = await Promise.all([
    client.list('dcim/sites'),
    client.list('dcim/racks'),
    client.list('dcim/devices'),
    client.list('ipam/ip-addresses'),
    client.list('dcim/cables'),
  ]);

  const ipsByDevice = new Map<number, { ip: Set<string>; fqdn: Set<string> }>();
  const ipEntry = (deviceId: number) => {
    let e = ipsByDevice.get(deviceId);
    if (!e) ipsByDevice.set(deviceId, (e = { ip: new Set(), fqdn: new Set() }));
    return e;
  };
  for (const ip of ips) {
    const deviceId = ip.assigned_object?.device?.id;
    if (typeof deviceId !== 'number' || typeof ip.address !== 'string') continue;
    const e = ipEntry(deviceId);
    e.ip.add(stripMask(ip.address));
    if (ip.dns_name) e.fqdn.add(String(ip.dns_name).toLowerCase());
  }

  const connections = new Map<number, { target: number; cable: number }[]>();
  const endDevices = (terms: unknown): number[] =>
    Array.isArray(terms) ? terms.map((t: any) => t?.object?.device?.id).filter((id): id is number => typeof id === 'number') : [];
  for (const cable of cables) {
    for (const a of new Set(endDevices(cable.a_terminations)))
      for (const b of new Set(endDevices(cable.b_terminations)))
        if (a !== b) connections.set(a, [...(connections.get(a) ?? []), { target: b, cable: cable.id }]);
  }

  const cis: UmbrellaCi[] = [];
  for (const s of sites) {
    cis.push({
      ...base('dcim.site', s, baseUrl),
      type: 'site',
      identities: {},
      logical_group: null,
      attributes: { slug: s.slug ?? null, region: name(s.region), tenant: name(s.tenant), facility: s.facility ?? null, tags: tags(s) },
      relations: [],
    });
  }
  for (const r of racks) {
    cis.push({
      ...base('dcim.rack', r, baseUrl),
      type: 'rack',
      identities: r.serial ? { serial: String(r.serial) } : {},
      logical_group: null,
      attributes: { site: name(r.site), location: name(r.location), role: name(r.role), tenant: name(r.tenant), tags: tags(r) },
      relations: r.site?.id ? [{ type: 'located_in', direction: 'out', target_ref: sourceRef('dcim.site', r.site.id) }] : [],
    });
  }
  for (const d of devices) {
    const addrs = ipEntry(d.id);
    for (const p of [d.primary_ip4, d.primary_ip6, d.oob_ip]) if (p?.address) addrs.ip.add(stripMask(p.address));
    const identities: UmbrellaCi['identities'] = {};
    if (d.name) identities.hostname = String(d.name).toLowerCase();
    if (addrs.fqdn.size) identities.fqdn = [...addrs.fqdn];
    if (addrs.ip.size) identities.ip = [...addrs.ip];
    if (d.serial) identities.serial = String(d.serial);
    if (d.asset_tag) identities.asset_tag = String(d.asset_tag);

    const relations: UmbrellaCi['relations'] = [];
    if (d.rack?.id) relations.push({ type: 'located_in', direction: 'out', target_ref: sourceRef('dcim.rack', d.rack.id) });
    else if (d.site?.id) relations.push({ type: 'located_in', direction: 'out', target_ref: sourceRef('dcim.site', d.site.id) });
    for (const c of connections.get(d.id) ?? [])
      relations.push({ type: 'connected_to', direction: 'out', target_ref: sourceRef('dcim.device', c.target), via: `cable ${c.cable}` });

    cis.push({
      ...base('dcim.device', d, baseUrl),
      type: 'device',
      identities,
      // A virtual chassis or cluster groups devices that fail over to each other.
      logical_group: name(d.virtual_chassis) ?? name(d.cluster),
      attributes: {
        role: name(d.role ?? d.device_role),
        manufacturer: name(d.device_type?.manufacturer),
        model: d.device_type?.model ?? null,
        platform: name(d.platform),
        tenant: name(d.tenant),
        site: name(d.site),
        rack: name(d.rack),
        position: d.position ?? null,
        tags: tags(d),
      },
      relations,
    });
  }
  return cis;
}
