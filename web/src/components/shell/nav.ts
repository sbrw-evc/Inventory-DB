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
  Activity,
  LockKeyhole,
  ShieldCheck,
  Vault,
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
  Monitor,
  PlugZap,
  Power,
  Zap,
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
  'dcim/front-port-templates': ListTree,
  'dcim/rear-port-templates': ListTree,
  'dcim/power-port-templates': ListTree,
  'dcim/power-outlet-templates': ListTree,
  'dcim/front-ports': EthernetPort,
  'dcim/rear-ports': EthernetPort,
  'dcim/power-panels': Zap,
  'dcim/power-feeds': Cable,
  'dcim/power-ports': PlugZap,
  'dcim/power-outlets': Power,
  'circuits/circuits': Cable,
  'circuits/circuit-terminations': Waypoints,
  'circuits/circuit-types': Tag,
  'circuits/providers': Building2,
  'circuits/provider-accounts': KeyRound,
  'circuits/provider-networks': Network,
  'virtualization/virtual-machines': Monitor,
  'virtualization/interfaces': EthernetPort,
  'virtualization/clusters': Boxes,
  'virtualization/cluster-types': Tag,
  'virtualization/cluster-groups': FolderTree,
  'extras/tags': Tags,
  'extras/custom-fields': SlidersHorizontal,
  'extras/object-changes': FileClock,
};

type Section = 'dcim' | 'circuits' | 'virtualization' | 'ipam' | 'admin';

/** Which sidebar group a NAV group of the NetBox pages goes to. */
function sectionOf(group: string, items: string[]): Section {
  if (group === 'other' || items.every((i) => i.startsWith('extras/'))) return 'admin';
  if (items.every((i) => i.startsWith('ipam/'))) return 'ipam';
  if (items.every((i) => i.startsWith('circuits/'))) return 'circuits';
  if (items.every((i) => i.startsWith('virtualization/'))) return 'virtualization';
  return 'dcim';
}

function netboxPages(section: Section): NavPage[] {
  const groups = NAV.filter((g) => sectionOf(g.group, g.items) === section);
  return groups.flatMap((g) =>
    g.items.map((p, i) => ({ id: p, to: `/${p}`, label: p, icon: TYPE_ICONS[p] ?? Database, netbox: true, sub: i === 0 && groups.length > 1 ? g.group : undefined })),
  );
}

/** A NetBox section shown as a sidebar group only when NAV has pages for it. */
function nbGroup(id: Section, title: string, icon: LucideIcon, extra: NavPage[] = []): NavGroup[] {
  const pages = [...extra, ...netboxPages(id)];
  return pages.length ? [{ id, title, icon, pages }] : [];
}

/** System settings (Umbrella's Settings group), for DCIM/IPAM administrators only. */
const SETTINGS: NavGroup = {
  id: 'settings',
  title: 'Settings',
  icon: SlidersHorizontal,
  pages: [
    { id: 'settings/status', to: '/settings/status', label: 'System status', icon: Activity },
    { id: 'settings/directory', to: '/settings/directory', label: 'Sign-in', icon: ShieldCheck },
    { id: 'settings/password-policy', to: '/settings/password-policy', label: 'Password policy', icon: LockKeyhole },
    { id: 'settings/postgresql', to: '/settings/postgresql', label: 'PostgreSQL', icon: Database },
    { id: 'settings/openbao', to: '/settings/openbao', label: 'OpenBao', icon: Vault },
  ],
};

export function navGroups(admin = false): NavGroup[] {
  return [
    { id: 'bases', title: 'Bases', icon: Database, pages: [], tree: 'bases' },
    ...nbGroup('dcim', 'DCIM', Server, [{ id: 'dcim/search', to: '/dcim/search', label: 'search', icon: Search, netbox: true }]),
    ...nbGroup('circuits', 'Circuits', Cable),
    ...nbGroup('virtualization', 'Virtualization', Boxes),
    ...nbGroup('ipam', 'IPAM', Network),
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
    ...(admin ? [SETTINGS] : []),
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
