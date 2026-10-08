import { createContext, useContext } from 'react';
import type { ListQuery, RecordData, Table } from '@shared';
import type { RecordSource } from '../../lib/records';
import type { Permissions } from '../../lib/roles';
import type { ResolvedColumn } from '../../lib/viewColumns';
import type { Move } from './GridEditor';

export const ROW_HEIGHTS = { short: 32, medium: 56, tall: 88 } as const;
export const HEADER_HEIGHT = 34;
export const NUM_COL_WIDTH = 76;
export const PAGE_SIZE = 100;
export const GROUP_PAGE_SIZE = 25;

export interface ActiveCell {
  section: string;
  row: number;
  col: number;
}

export interface GridCtx {
  table: Table;
  /** Visible columns in display order. */
  columns: ResolvedColumn[];
  rowHeight: number;
  perms: Permissions;
  source: RecordSource;
  baseQuery: ListQuery;
  active: ActiveCell | null;
  editing: { initialText?: string } | null;
  selected: Set<number>;
  /** Left offset of each visible column (after the row-number column). */
  offsets: number[];
  totalWidth: number;
  registerSection: (key: string, rows: RecordData[]) => void;
  setActive: (a: ActiveCell | null) => void;
  startEditing: (a: ActiveCell, initialText?: string) => void;
  commit: (a: ActiveCell, value: unknown, move: Move) => void;
  cancelEdit: () => void;
  quickChange: (row: RecordData, columnId: string, value: unknown) => void;
  toggleSelected: (id: number, on?: boolean) => void;
  onExpand: (id: number) => void;
  addRow: (defaults?: Record<string, unknown>) => void;
}

export const GridContext = createContext<GridCtx | null>(null);

export function useGrid(): GridCtx {
  const ctx = useContext(GridContext);
  if (!ctx) throw new Error('useGrid outside GridContext');
  return ctx;
}
