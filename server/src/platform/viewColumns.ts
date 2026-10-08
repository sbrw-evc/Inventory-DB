import type { Column, RecordData, Table, View, ViewColumn } from '../../../shared/src/index.js';

export interface ShownColumn {
  column: Column;
  viewColumn: ViewColumn | undefined;
}

/**
 * Columns a view shows, in view order. Columns missing from `view.columns` (e.g. added after the view)
 * count as shown, after the configured ones, except on form views where they are hidden.
 */
export function shownColumns(table: Table, view: View): ShownColumn[] {
  const byId = new Map(view.columns.map((vc) => [vc.columnId, vc]));
  const out: (ShownColumn & { key: number })[] = [];
  for (const column of table.columns) {
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
