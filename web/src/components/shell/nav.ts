import {
  Boxes,
  Building2,
  Cable,
  CircuitBoard,
  Cpu,
  Database,
  EthernetPort,
  Factory,
  FileClock,
  FolderTree,
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  ListTree,
  MapPin,
  Network,
  Plug,
  Route,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  Split,
  Tag,
  Tags,
  ArrowRightLeft,
  UsersRound,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { NAV } from '../../netbox/nav';

/**
 * The application menu, grouped like Umbrella's sidebar: each group is an accordion of pages.
 * The DCIM and IPAM groups follow netbox/nav.ts (NAV), so object types added there appear here.
 */
export type NavPage = { id: string; to: string; label: string; icon: LucideIcon; /** labels resolved by the NetBox dictionary */ netbox?: boolean; sub?: string };
export type NavGroup = { id: string; title: string; icon: LucideIcon; pages: NavPage[]; tree?: 'bases' };

const TYPE_ICONS: Record<string, LucideIcon> = {
  'dcim/regions': Globe,
  'dcim/sites': Building2,
  'dcim/locations': MapPin,
  'tenancy/tenants': UsersRound,
  'tenancy/tenant-groups': FolderTree,
  'dcim/racks': Server,
  'dcim/rack-roles': Tag,
  'dcim/devices': HardDrive,
  'dcim/device-roles': Tag,
  'dcim/platforms': Cpu,
  'dcim/device-types': CircuitBoard,
  'dcim/manufacturers': Factory,
  'dcim/interface-templates': ListTree,
  'dcim/interfaces': EthernetPort,
  'dcim/cables': Cable,
  'ipam/prefixes': Network,
  'ipam/ip-ranges': Split,
  'ipam/ip-addresses': Waypoints,
  'ipam/aggregates': Layers,
  'ipam/rirs': Boxes,
  'ipam/vrfs': Route,
  'ipam/route-targets': Route,
  'ipam/roles': Tag,
  'ipam/vlans': Layers,
  'ipam/vlan-groups': FolderTree,
  'extras/tags': Tags,
  'extras/custom-fields': SlidersHorizontal,
  'extras/object-changes': FileClock,
};

/** Which sidebar group a NAV group of the NetBox pages goes to. */
function sectionOf(group: string, items: string[]): 'dcim' | 'ipam' | 'admin' {
  if (group === 'other' || items.every((i) => i.startsWith('extras/'))) return 'admin';
  if (items.every((i) => i.startsWith('ipam/'))) return 'ipam';
  return 'dcim';
}

function netboxPages(section: 'dcim' | 'ipam' | 'admin'): NavPage[] {
  return NAV.filter((g) => sectionOf(g.group, g.items) === section).flatMap((g) =>
    g.items.map((p, i) => ({ id: p, to: `/${p}`, label: p.split('/')[1], icon: TYPE_ICONS[p] ?? Database, netbox: true, sub: i === 0 && section !== 'admin' ? g.group : undefined })),
  );
}

export function navGroups(): NavGroup[] {
  return [
    { id: 'bases', title: 'Bases', icon: Database, pages: [], tree: 'bases' },
    { id: 'dcim', title: 'DCIM', icon: Server, pages: [{ id: 'dcim/search', to: '/dcim/search', label: 'search', icon: Search, netbox: true }, ...netboxPages('dcim')] },
    { id: 'ipam', title: 'IPAM', icon: Network, pages: netboxPages('ipam') },
    {
      id: 'integrations',
      title: 'Integrations',
      icon: Plug,
      pages: [
        { id: 'integrations', to: '/integrations', label: 'Integrations', icon: Plug },
        { id: 'admin/data', to: '/admin/data', label: 'Import & migration', icon: ArrowRightLeft },
      ],
    },
    {
      id: 'admin',
      title: 'Administration',
      icon: Settings,
      pages: [{ id: 'admin/tokens', to: '/admin/tokens', label: 'API tokens', icon: KeyRound }, ...netboxPages('admin')],
    },
  ];
}

/** Whether a page owns the current path (its own path or anything below it). */
export function owns(page: NavPage, path: string) {
  return path === page.to || path.startsWith(page.to + '/');
}

/** Whether the bases group owns the path. */
export function basesOwn(path: string) {
  return path === '/' || path.startsWith('/base/');
}
