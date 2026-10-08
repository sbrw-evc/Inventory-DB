// TEMP stub so the platform module typechecks before the data engine is merged. Drop at merge.
import type { FilterGroup, GroupResult, ListQuery, ListResult, RecordData } from '../../../shared/src/index.js';

interface WriteCtx {
  userId?: string | null;
}

const ni = (): never => {
  throw new Error('not implemented');
};

export function listRecords(_tableId: string, _query: ListQuery): ListResult {
  return ni();
}
export function getRecord(_tableId: string, _id: number): RecordData {
  return ni();
}
export function insertRecords(_tableId: string, _rows: Record<string, unknown>[], _ctx: WriteCtx): RecordData[] {
  return ni();
}
export function updateRecords(_tableId: string, _rows: ({ id: number } & Record<string, unknown>)[], _ctx: WriteCtx): RecordData[] {
  return ni();
}
export function deleteRecords(_tableId: string, _ids: number[], _ctx: WriteCtx): number {
  return ni();
}
export function linkRecords(_columnId: string, _recordId: number, _ids: number[], _ctx: WriteCtx): void {
  return ni();
}
export function unlinkRecords(_columnId: string, _recordId: number, _ids: number[], _ctx: WriteCtx): void {
  return ni();
}
export function listLinked(_columnId: string, _recordId: number, _q: { offset?: number; limit?: number; search?: string }): ListResult {
  return ni();
}
export function groupRecords(
  _tableId: string,
  _q: { viewId?: string; columnId: string; filter?: FilterGroup; search?: string },
): GroupResult[] {
  return ni();
}
