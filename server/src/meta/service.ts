// TEMP stub so the platform module typechecks before the data engine is merged. Drop at merge.
import type { Base, Column, ColumnOptions, FieldType, Table, View, ViewType } from '../../../shared/src/index.js';

interface ColumnInput {
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
export function createBase(_userId: string, _input: { title: string; description?: string | null; color?: string | null }): Base {
  return ni();
}
export function getBase(_baseId: string): Base & { tables: Table[] } {
  return ni();
}
export function updateBase(_baseId: string, _patch: Partial<Pick<Base, 'title' | 'description' | 'color' | 'order'>>): Base {
  return ni();
}
export function deleteBase(_baseId: string): void {
  return ni();
}
export function createTable(_baseId: string, _input: { title: string; columns?: ColumnInput[] }): Table {
  return ni();
}
export function getTable(_tableId: string): Table {
  return ni();
}
export function listTables(_baseId: string): Table[] {
  return ni();
}
export function updateTable(_tableId: string, _patch: { title?: string; description?: string | null; order?: number }): Table {
  return ni();
}
export function deleteTable(_tableId: string): void {
  return ni();
}
export function addColumn(_tableId: string, _input: ColumnInput): Column {
  return ni();
}
export function updateColumn(_columnId: string, _patch: Partial<ColumnInput>): Column {
  return ni();
}
export function deleteColumn(_columnId: string): void {
  return ni();
}
export function createView(_tableId: string, _input: { title: string; type: ViewType; copyFromViewId?: string }): View {
  return ni();
}
export function updateView(_viewId: string, _patch: Partial<Omit<View, 'id' | 'tableId'>>): View {
  return ni();
}
export function deleteView(_viewId: string): void {
  return ni();
}
export function getView(_viewId: string): View {
  return ni();
}
