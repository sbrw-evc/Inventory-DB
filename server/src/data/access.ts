/**
 * Field-level permissions (NocoDB-style). Route handlers pass the caller's base role as `access`; internal
 * callers (template, import, migration, integrations) pass nothing and keep full access.
 *
 * A field hidden for a role behaves as if it did not exist for that role: it is left out of records and table
 * meta, and filters/sorts/search/fields that name it are rejected like unknown fields. Computed fields
 * (Formula, Lookup, Rollup) that read a hidden field are hidden too, so its values can't leak through them.
 */
import type { Column, FilterCondition, FilterGroup, RecordData, Role, Sort, Table, View } from '../../../shared/src/index.js';
import { isFieldHidden, isFieldReadOnlyFor, isFilterGroup } from '../../../shared/src/index.js';
import { badRequest, forbidden } from '../errors.js';
import { type ColumnMeta, findColumn, loadColumns } from '../meta/store.js';
import { collectRefs, parseFormula } from './formula.js';

export interface Access {
  role: Role;
}

/** True when the caller has unrestricted access (internal call or base owner). */
export const isFullAccess = (access: Access | undefined): boolean => !access || access.role === 'owner';

type Loader = (tableId: string) => ColumnMeta[];

function formulaRefs(col: ColumnMeta): string[] {
  if (!col.options.formula) return [];
  try {
    return collectRefs(parseFormula(col.options.formula));
  } catch {
    return [];
  }
}

/**
 * Ids of the columns of `tableId` that `role` can't read (`undefined` role = anonymous shared-view visitor),
 * including computed columns that depend on a hidden column.
 */
export function hiddenColumnIdsForRole(tableId: string, role: Role | undefined, load: Loader = loadColumns): Set<string> {
  const out = new Set<string>();
  if (role === 'owner') return out;
  const cache = new Map<string, ColumnMeta[]>();
  const cols = (tid: string) => {
    let c = cache.get(tid);
    if (!c) cache.set(tid, (c = load(tid)));
    return c;
  };
  const memo = new Map<string, boolean>();
  const isHidden = (col: ColumnMeta | undefined | null, depth: number): boolean => {
    if (!col) return false;
    const known = memo.get(col.id);
    if (known !== undefined) return known;
    memo.set(col.id, false); // cycle guard
    let hidden = isFieldHidden(col, role);
    if (!hidden && depth < 8) {
      if (col.type === 'Formula') {
        const byId = new Map(cols(col.tableId).map((c) => [c.id, c]));
        hidden = formulaRefs(col).some((ref) => isHidden(byId.get(ref), depth + 1));
      } else if (col.type === 'Lookup' || col.type === 'Rollup') {
        const link = cols(col.tableId).find((c) => c.id === col.options.linkColumnId);
        const target = col.options.targetColumnId ? (findColumn(col.options.targetColumnId) ?? undefined) : undefined;
        hidden = isHidden(link, depth + 1) || (!!target && isHidden(cols(target.tableId).find((c) => c.id === target.id), depth + 1));
      }
    }
    memo.set(col.id, hidden);
    return hidden;
  };
  for (const c of cols(tableId)) if (isHidden(c, 0)) out.add(c.id);
  return out;
}

export function hiddenColumnIds(tableId: string, access: Access | undefined, load?: Loader): Set<string> {
  if (isFullAccess(access)) return new Set();
  return hiddenColumnIdsForRole(tableId, access!.role, load);
}

/** Throws 400 when a filter names a hidden field (reported like an unknown field). */
export function assertFilterVisible(filter: FilterGroup | null | undefined, hidden: Set<string>) {
  if (!filter || !hidden.size) return;
  const walk = (f: FilterGroup | FilterCondition) => {
    if (isFilterGroup(f)) {
      if (Array.isArray(f.children)) f.children.forEach(walk);
    } else if (hidden.has(f.columnId)) throw badRequest(`Filter references unknown field ${f.columnId}`);
  };
  walk(filter);
}

export function assertSortsVisible(sorts: Sort[] | undefined, hidden: Set<string>, what = 'Sort') {
  if (!sorts || !hidden.size) return;
  for (const s of sorts) if (hidden.has(s.columnId)) throw badRequest(`${what} references unknown field ${s.columnId}`);
}

/** Throws 403 when `role` may not write column `col`. */
export function assertWritable(col: ColumnMeta, access: Access | undefined, hidden: Set<string>) {
  if (isFullAccess(access)) return;
  if (hidden.has(col.id) || isFieldReadOnlyFor(col, access!.role))
    throw forbidden(`You do not have permission to edit the field "${hidden.has(col.id) ? col.id : col.title}"`);
}

export function stripHidden<R extends Record<string, unknown>>(rec: R, hidden: Set<string>): R {
  if (!hidden.size) return rec;
  const out = { ...rec };
  for (const id of hidden) delete out[id];
  return out;
}

export const stripRecords = (list: RecordData[], hidden: Set<string>) => (hidden.size ? list.map((r) => stripHidden(r, hidden)) : list);

/** Table meta as `role` may see it: hidden columns left out (also from views' column lists). */
export function tableForRole(table: Table, role: Role | undefined): Table {
  if (role === 'owner') return table;
  const hidden = hiddenColumnIdsForRole(table.id, role);
  if (!hidden.size) return table;
  return {
    ...table,
    columns: table.columns.filter((c: Column) => !hidden.has(c.id)),
    views: table.views?.map((v) => viewForHidden(v, hidden)),
  };
}

export function viewForHidden(view: View, hidden: Set<string>): View {
  if (!hidden.size) return view;
  return { ...view, columns: view.columns.filter((c) => !hidden.has(c.columnId)) };
}
