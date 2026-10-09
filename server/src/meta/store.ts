/**
 * Low-level metadata access: row <-> object mapping for nc_bases / nc_tables / nc_columns / nc_views.
 * No business rules live here; see service.ts.
 */
import type { Base, Column, ColumnOptions, FieldType, FilterGroup, Sort, View, ViewColumn, ViewMeta, ViewType } from '../../../shared/src/index.js';
import { getDb, json, linkTableName } from '../db/index.js';
import { notFound } from '../errors.js';

/** Server-only keys kept in nc_columns.options; stripped from API output. */
export interface InternalOptions {
  /** Links: id of the column that owns the junction table l_<id> */
  _jt?: string;
  /** Links: which junction side holds this table's record id */
  _side?: 'a' | 'b';
  /** System column created with the table (ID / CreatedTime / LastModifiedTime) */
  _system?: boolean;
}

export type ColumnMeta = Omit<Column, 'options'> & { options: ColumnOptions & InternalOptions };

export interface BaseRow {
  id: string;
  title: string;
  description: string | null;
  color: string | null;
  order: number;
  created_at: string;
}
export interface TableRow {
  id: string;
  base_id: string;
  title: string;
  description: string | null;
  order: number;
  created_at: string;
}
interface ColumnRow {
  id: string;
  table_id: string;
  title: string;
  type: string;
  is_primary: number;
  required: number;
  default_value: string | null;
  description: string | null;
  options: string;
  order: number;
}
interface ViewRow {
  id: string;
  table_id: string;
  title: string;
  type: string;
  order: number;
  locked: number;
  filter: string | null;
  sorts: string;
  columns: string;
  meta: string;
  share_uuid: string | null;
  share_password_hash: string | null;
}

export const toBase = (r: BaseRow): Base => ({
  id: r.id,
  title: r.title,
  description: r.description,
  color: r.color,
  order: r.order,
  createdAt: r.created_at,
});

export function toColumnMeta(r: ColumnRow): ColumnMeta {
  const options = json<ColumnMeta['options']>(r.options, {});
  return {
    id: r.id,
    tableId: r.table_id,
    title: r.title,
    type: r.type as FieldType,
    primary: !!r.is_primary,
    required: !!r.required,
    defaultValue: r.default_value == null ? undefined : json<unknown>(r.default_value, undefined),
    description: r.description,
    options,
    order: r.order,
    system: !!options._system,
  };
}

export function toView(r: ViewRow): View {
  return {
    id: r.id,
    tableId: r.table_id,
    title: r.title,
    type: r.type as ViewType,
    order: r.order,
    locked: !!r.locked,
    filter: json<FilterGroup | null>(r.filter, null),
    sorts: json<Sort[]>(r.sorts, []),
    columns: json<ViewColumn[]>(r.columns, []),
    meta: json<ViewMeta>(r.meta, {}),
    shareUuid: r.share_uuid,
    sharePasswordSet: !!r.share_password_hash,
  };
}

export function baseRow(baseId: string): BaseRow {
  const r = getDb().prepare('SELECT * FROM nc_bases WHERE id = ?').get(baseId) as BaseRow | undefined;
  if (!r) throw notFound('Base');
  return r;
}

export function tableRow(tableId: string): TableRow {
  const r = getDb().prepare('SELECT * FROM nc_tables WHERE id = ?').get(tableId) as TableRow | undefined;
  if (!r) throw notFound('Table');
  return r;
}

export function loadColumns(tableId: string): ColumnMeta[] {
  return (getDb().prepare('SELECT * FROM nc_columns WHERE table_id = ? ORDER BY "order", created_at').all(tableId) as ColumnRow[]).map(
    toColumnMeta,
  );
}

export function findColumn(columnId: string): ColumnMeta | null {
  const r = getDb().prepare('SELECT * FROM nc_columns WHERE id = ?').get(columnId) as ColumnRow | undefined;
  return r ? toColumnMeta(r) : null;
}

export function loadColumn(columnId: string): ColumnMeta {
  const c = findColumn(columnId);
  if (!c) throw notFound('Column');
  return c;
}

export function loadViewRows(tableId: string): View[] {
  return (getDb().prepare('SELECT * FROM nc_views WHERE table_id = ? ORDER BY "order", created_at').all(tableId) as ViewRow[]).map(toView);
}

export function findView(viewId: string): View | null {
  const r = getDb().prepare('SELECT * FROM nc_views WHERE id = ?').get(viewId) as ViewRow | undefined;
  return r ? toView(r) : null;
}

export function saveColumnOptions(columnId: string, options: ColumnMeta['options']) {
  getDb().prepare('UPDATE nc_columns SET options = ? WHERE id = ?').run(JSON.stringify(options), columnId);
}

/** Junction table and side names for a Links column. */
export function linkInfo(col: ColumnMeta) {
  const self = col.options._side === 'b' ? 'b_id' : 'a_id';
  const other = self === 'a_id' ? 'b_id' : 'a_id';
  return {
    junction: linkTableName(col.options._jt ?? col.id),
    self,
    other,
    relatedTableId: col.options.relatedTableId!,
  };
}
