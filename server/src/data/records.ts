// TEMP stub: the real data engine replaces this file at merge.
import type { GroupResult, ListQuery, ListResult, RecordData } from '../../../shared/src/index.js';

interface StubCtx {
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
export function insertRecords(_tableId: string, _rows: Record<string, unknown>[], _ctx: StubCtx): RecordData[] {
  return ni();
}
export function updateRecords(_tableId: string, _rows: ({ id: number } & Record<string, unknown>)[], _ctx: StubCtx): RecordData[] {
  return ni();
}
export function deleteRecords(_tableId: string, _ids: number[], _ctx: StubCtx): number {
  return ni();
}
export function linkRecords(_columnId: string, _recordId: number, _ids: number[], _ctx: StubCtx): void {
  ni();
}
export function unlinkRecords(_columnId: string, _recordId: number, _ids: number[], _ctx: StubCtx): void {
  ni();
}
export function listLinked(_columnId: string, _recordId: number, _opts: { offset?: number; limit?: number; search?: string }): ListResult {
  return ni();
}
export function groupRecords(_tableId: string, _opts: { viewId?: string; columnId: string; filter?: unknown; search?: string }): GroupResult[] {
  return ni();
}
