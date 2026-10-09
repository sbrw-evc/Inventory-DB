import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { GroupResult, ListQuery, ListResult, RecordData } from '@shared';
import { dataApi, publicApi } from '../api/endpoints';
import { qk } from '../api/hooks';
import { t } from '../i18n';
import { toast, toastError } from './toast';

/** Where a view reads its records from: the authenticated API or a public share link. */
export interface RecordSource {
  /** Query-key prefix; must start with ['records', tableId] so mutations can find it. */
  key: readonly unknown[];
  tableId: string;
  list: (q: ListQuery, signal?: AbortSignal) => Promise<ListResult>;
  groups?: (q: { columnId: string; filter?: ListQuery['filter']; search?: string }, signal?: AbortSignal) => Promise<GroupResult[]>;
}

export function apiSource(tableId: string, viewId: string): RecordSource {
  return {
    key: [...qk.records(tableId), viewId],
    tableId,
    list: (q, signal) => dataApi.list(tableId, { ...q, viewId }, signal),
    groups: (q, signal) => dataApi.groups(tableId, { ...q, viewId }, signal),
  };
}

export function publicSource(tableId: string, shareUuid: string, password: string | null): RecordSource {
  return {
    key: [...qk.records(tableId), 'public', shareUuid, password],
    tableId,
    list: (q, signal) => publicApi.listRecords(shareUuid, q, password, signal),
  };
}

type Cached = InfiniteData<ListResult> | ListResult | undefined;

function mapCached(data: Cached, fn: (r: RecordData) => RecordData): Cached {
  if (!data) return data;
  if ('pages' in data) {
    return { ...data, pages: data.pages.map((p) => ({ ...p, list: p.list.map(fn) })) };
  }
  if ('list' in data && Array.isArray(data.list)) return { ...data, list: data.list.map(fn) };
  return data;
}

const isLinkDetail = (v: unknown): v is Array<{ id: number; display: unknown }> =>
  Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && 'id' in x && 'display' in x);

/**
 * Single-record responses carry Links as `[{id, display}]` (max 25) while lists carry counts: convert so list
 * cells keep showing "N records". Returns the keys whose count may be truncated (25+), to refetch.
 */
export function normalizeForList(patch: Record<string, unknown>): { patch: Record<string, unknown>; stale: boolean } {
  let stale = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (isLinkDetail(v)) {
      out[k] = v.length;
      if (v.length >= 25) stale = true;
    } else out[k] = v;
  }
  return { patch: out, stale };
}

/** Applies a changed record to every cached list of the table (optimistic and server echo). */
export function patchCachedRecord(qc: QueryClient, tableId: string, id: number, patch: Record<string, unknown>) {
  const forList = normalizeForList(patch);
  qc.setQueriesData<Cached>({ queryKey: qk.records(tableId) }, (data) =>
    mapCached(data, (r) => (r.id === id ? { ...r, ...forList.patch } : r)),
  );
  if (forList.stale) void qc.invalidateQueries({ queryKey: qk.records(tableId) });
  qc.setQueryData<RecordData>(qk.record(tableId, id), (r) => (r ? { ...r, ...patch } : r));
}

/** Other tables' lookups/rollups may depend on this one: mark them stale (refetch when shown). */
export function invalidateDependents(qc: QueryClient, tableId: string) {
  return qc.invalidateQueries({
    predicate: (q) => q.queryKey[0] === 'records' && q.queryKey[1] !== tableId,
  });
}

/** Current value of one cell from any cached list of the table. */
function findCachedValue(qc: QueryClient, tableId: string, rowId: number, columnId: string): unknown {
  for (const [, data] of qc.getQueriesData<Cached>({ queryKey: qk.records(tableId) })) {
    if (!data) continue;
    const lists = 'pages' in data ? data.pages.map((p) => p.list) : 'list' in data && Array.isArray(data.list) ? [data.list] : [];
    for (const l of lists) {
      const r = l.find((x) => x.id === rowId);
      if (r && columnId in r) return r[columnId];
    }
  }
  return null;
}

interface UndoEntry {
  tableId: string;
  rowId: number;
  columnId: string;
  prev: unknown;
}
const undoStack: UndoEntry[] = [];
/** Entries undone, newest last; cleared by any new edit. Each holds the value to re-apply. */
const redoStack: UndoEntry[] = [];

export function useRecordMutations(tableId: string) {
  const qc = useQueryClient();

  const updateCell = useCallback(
    async (rowId: number, columnId: string, value: unknown, prev: unknown, opts: { skipUndo?: boolean; keepRedo?: boolean } = {}) => {
      patchCachedRecord(qc, tableId, rowId, { [columnId]: value });
      try {
        const saved = await dataApi.update(tableId, rowId, { [columnId]: value });
        if (saved && typeof saved === 'object') patchCachedRecord(qc, tableId, rowId, saved);
        if (!opts.skipUndo) {
          undoStack.push({ tableId, rowId, columnId, prev });
          if (undoStack.length > 100) undoStack.shift();
          if (!opts.keepRedo) redoStack.length = 0;
        }
        void invalidateDependents(qc, tableId);
        void qc.invalidateQueries({ queryKey: qk.groups(tableId) });
        return saved;
      } catch (e) {
        patchCachedRecord(qc, tableId, rowId, { [columnId]: prev });
        toastError(e);
        return null;
      }
    },
    [qc, tableId],
  );

  const updateRecord = useCallback(
    async (rowId: number, data: Record<string, unknown>) => {
      try {
        const saved = await dataApi.update(tableId, rowId, data);
        patchCachedRecord(qc, tableId, rowId, saved ?? data);
        void qc.invalidateQueries({ queryKey: qk.records(tableId) });
        void invalidateDependents(qc, tableId);
        return saved;
      } catch (e) {
        toastError(e);
        return null;
      }
    },
    [qc, tableId],
  );

  const createRecord = useCallback(
    async (data: Record<string, unknown>) => {
      try {
        const created = await dataApi.create(tableId, data);
        await qc.invalidateQueries({ queryKey: qk.records(tableId) });
        void qc.invalidateQueries({ queryKey: qk.groups(tableId) });
        void invalidateDependents(qc, tableId);
        return created;
      } catch (e) {
        toastError(e);
        return null;
      }
    },
    [qc, tableId],
  );

  const deleteRecords = useCallback(
    async (ids: number[]) => {
      try {
        if (ids.length === 1) await dataApi.remove(tableId, ids[0]);
        else await dataApi.removeMany(tableId, ids);
        await qc.invalidateQueries({ queryKey: qk.records(tableId) });
        void qc.invalidateQueries({ queryKey: qk.groups(tableId) });
        void invalidateDependents(qc, tableId);
        toast(ids.length === 1 ? t('Record deleted') : t('{n} records deleted', { n: ids.length }), 'success');
        return true;
      } catch (e) {
        toastError(e);
        return false;
      }
    },
    [qc, tableId],
  );

  const undo = useCallback(async () => {
    const idx = undoStack.map((u) => u.tableId).lastIndexOf(tableId);
    if (idx < 0) {
      toast(t('Nothing to undo'));
      return;
    }
    const [entry] = undoStack.splice(idx, 1);
    const current = qc.getQueryData<RecordData>(qk.record(tableId, entry.rowId))?.[entry.columnId] ?? findCachedValue(qc, tableId, entry.rowId, entry.columnId);
    const ok = await updateCell(entry.rowId, entry.columnId, entry.prev, undefined, { skipUndo: true });
    if (ok) {
      redoStack.push({ ...entry, prev: current });
      toast(t('Undone'), 'success', 1500);
    }
  }, [qc, tableId, updateCell]);

  const redo = useCallback(async () => {
    const idx = redoStack.map((u) => u.tableId).lastIndexOf(tableId);
    if (idx < 0) {
      toast(t('Nothing to redo'));
      return;
    }
    const [entry] = redoStack.splice(idx, 1);
    const before = findCachedValue(qc, tableId, entry.rowId, entry.columnId);
    const ok = await updateCell(entry.rowId, entry.columnId, entry.prev, before, { keepRedo: true });
    if (ok) toast(t('Redone'), 'success', 1500);
  }, [qc, tableId, updateCell]);

  return { updateCell, updateRecord, createRecord, deleteRecords, undo, redo };
}
