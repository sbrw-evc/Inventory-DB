import { navGroups, owns, type NavGroup, type NavPage } from './nav';

/**
 * The phone layout's pages (Beacon's mobilePages): finding a device, its rack, its addresses and
 * circuits works on the phone. Integrations, imports, administration and system settings are made
 * for a computer: the phone shows a note and opens them only on request.
 */
const DESK_PREFIXES = ['/integrations', '/admin', '/settings', '/extras/custom-fields'];

export function mobileReady(path: string) {
  return !DESK_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

/** The objects an engineer looks up most, first in "More". */
export const MORE_TILES = ['dcim/devices', 'dcim/sites', 'dcim/racks', 'ipam/ip-addresses', 'ipam/prefixes', 'ipam/vlans'];

/** The page that owns the path; the longest path wins. */
export function pageOf(groups: NavGroup[], path: string): NavPage | undefined {
  return groups
    .flatMap((g) => g.pages)
    .sort((a, b) => b.to.length - a.to.length)
    .find((p) => owns(p, path));
}

export { navGroups };
