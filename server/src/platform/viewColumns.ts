import type { Column, RecordData, Role, Table, View, ViewColumn } from '../../../shared/src/index.js';
import { isFieldReadOnlyFor } from '../../../shared/src/index.js';
import { hiddenColumnIdsForRole } from '../data/access.js';

export interface ShownColumn {
  column: Column;
  viewColumn: ViewColumn | undefined;
}

/**
 * Columns a view shows, in view order. Columns missing from `view.columns` (e.g. added after the view)
 * count as shown, after the configured ones, except on form views where they are hidden.
 *
 * Field permissions: columns hidden for `viewer.role` are left out. Without a role (public shared views and
 * forms) every column hidden for any role is left out, and forms also leave out columns read-only for any role.
 */
export function shownColumns(table: Table, view: View, viewer: { role?: Role } = {}): ShownColumn[] {
  const byId = new Map(view.columns.map((vc) => [vc.columnId, vc]));
  const hidden = hiddenColumnIdsForRole(table.id, viewer.role);
  const out: (ShownColumn & { key: number })[] = [];
  for (const column of table.columns) {
    if (hidden.has(column.id)) continue;
    if (!viewer.role && view.type === 'form' && isFieldReadOnlyFor(column, undefined)) continue;
    const vc = byId.get(column.id);
    const show = vc ? vc.show : view.type !== 'form';
    if (!show) continue;
    out.push({ column, viewColumn: vc, key: vc ? vc.order : 1e9 + column.order });
  }
  out.sort((a, b) => a.key - b.key);
  return out.map(({ column, viewColumn }) => ({ column, viewColumn }));
}

/** Keep only `id` and the given column ids. */
export function pickColumns(rec: RecordData, ids: Set<string>): RecordData {
  const out: RecordData = { id: rec.id };
  for (const [k, v] of Object.entries(rec)) if (ids.has(k)) out[k] = v;
  return out;
}
