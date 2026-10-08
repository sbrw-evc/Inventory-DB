import { createContext, useContext } from 'react';
import type { Column, Table } from '@shared';
import { PUBLIC_PERMISSIONS, type Permissions } from './roles';

export interface BaseData {
  baseId: string | null;
  tables: Table[];
  perms: Permissions;
  /** Public shared page: no authenticated API calls allowed. */
  isPublic?: boolean;
}

export const BaseDataContext = createContext<BaseData>({ baseId: null, tables: [], perms: PUBLIC_PERMISSIONS, isPublic: true });

export const useBaseData = () => useContext(BaseDataContext);

export function findTable(tables: Table[], tableId?: string): Table | undefined {
  return tables.find((t) => t.id === tableId);
}

export function primaryColumn(table: Table | undefined): Column | undefined {
  if (!table) return undefined;
  return table.columns.find((c) => c.primary) ?? table.columns.find((c) => c.type !== 'ID') ?? table.columns[0];
}

/** For Lookup columns: the column on the related table whose values are shown. */
export function lookupTarget(column: Column, tables: Table[], ownTable?: Table): Column | undefined {
  if (column.type !== 'Lookup' && column.type !== 'Rollup') return undefined;
  const own = ownTable ?? tables.find((t) => t.id === column.tableId);
  const link = own?.columns.find((c) => c.id === column.options.linkColumnId);
  const related = tables.find((t) => t.id === link?.options.relatedTableId);
  return related?.columns.find((c) => c.id === column.options.targetColumnId);
}

export function recordTitle(table: Table | undefined, row: Record<string, unknown> | undefined): string {
  if (!row) return '';
  const pc = primaryColumn(table);
  const v = pc ? row[pc.id] : undefined;
  if (v === null || v === undefined || v === '') return `Record ${String(row.id ?? '')}`.trim();
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
