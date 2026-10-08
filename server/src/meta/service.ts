// TEMP stub: the real data engine replaces this file at merge.
import type { Base, Column, ColumnOptions, FieldType, Table, View, ViewType } from '../../../shared/src/index.js';

interface StubColumnInput {
  title: string;
  type: FieldType;
  options?: ColumnOptions;
  required?: boolean;
  defaultValue?: unknown;
  description?: string | null;
  primary?: boolean;
}

const ni = (): never => {
  throw new Error('not implemented');
};

export function listBases(_userId: string): Base[] {
  return ni();
}
export function createBase(_userId: string, _input: { title: string; description?: string; color?: string }): Base {
  return ni();
}
export function getBase(_baseId: string): Base & { tables: Table[] } {
  return ni();
}
export function updateBase(_baseId: string, _patch: Partial<Base>): Base {
  return ni();
}
export function deleteBase(_baseId: string): void {
  ni();
}
export function createTable(_baseId: string, _input: { title: string; columns?: StubColumnInput[] }): Table {
  return ni();
}
export function getTable(_tableId: string): Table {
  return ni();
}
export function listTables(_baseId: string): Table[] {
  return ni();
}
export function updateTable(_tableId: string, _patch: Partial<Table>): Table {
  return ni();
}
export function deleteTable(_tableId: string): void {
  ni();
}
export function addColumn(_tableId: string, _input: StubColumnInput): Column {
  return ni();
}
export function updateColumn(_columnId: string, _patch: Partial<StubColumnInput>): Column {
  return ni();
}
export function deleteColumn(_columnId: string): void {
  ni();
}
export function createView(_tableId: string, _input: { title: string; type: ViewType; copyFromViewId?: string }): View {
  return ni();
}
export function updateView(_viewId: string, _patch: Partial<Omit<View, 'id' | 'tableId' | 'type'>>): View {
  return ni();
}
export function deleteView(_viewId: string): void {
  ni();
}
export function getView(_viewId: string): View {
  return ni();
}
