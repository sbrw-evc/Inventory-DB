import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Base, Column, Table, View } from '@shared';
import { toastError } from '../lib/toast';
import { type BaseWithTables, metaApi } from './endpoints';

export const qk = {
  me: ['me'] as const,
  bases: ['bases'] as const,
  base: (baseId: string) => ['base', baseId] as const,
  /** Prefix for every records/groups query of a table. */
  records: (tableId: string) => ['records', tableId] as const,
  groups: (tableId: string) => ['groups', tableId] as const,
  record: (tableId: string, id: number) => ['record', tableId, id] as const,
  links: (tableId: string, id: number, columnId: string) => ['links', tableId, id, columnId] as const,
  comments: (tableId: string, id: number) => ['comments', tableId, id] as const,
  recordAudit: (tableId: string, id: number) => ['recordAudit', tableId, id] as const,
  members: (baseId: string) => ['members', baseId] as const,
  baseAudit: (baseId: string) => ['baseAudit', baseId] as const,
  tokens: ['tokens'] as const,
  hooks: (tableId: string) => ['hooks', tableId] as const,
  hookLogs: (hookId: string) => ['hookLogs', hookId] as const,
};

export function useBases() {
  return useQuery({ queryKey: qk.bases, queryFn: metaApi.listBases });
}

export function useBase(baseId: string | undefined) {
  return useQuery({
    queryKey: qk.base(baseId ?? ''),
    queryFn: () => metaApi.getBase(baseId!),
    enabled: !!baseId,
  });
}

/** A mutation that reports errors as toasts and invalidates the given query keys on success. */
export function useApiMutation<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { invalidate?: (vars: TVars, result: TResult) => QueryKey[]; onSuccess?: (result: TResult, vars: TVars) => void; silent?: boolean } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, vars) => {
      const keys = opts.invalidate?.(vars, result) ?? [];
      await Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
      opts.onSuccess?.(result, vars);
    },
    onError: (err) => {
      if (!opts.silent) toastError(err);
    },
  });
}

/** Cache helpers for the `GET /bases/:id` payload (tables → columns + views). */
export function useBaseCache() {
  const qc = useQueryClient();
  return useMemo(() => baseCache(qc), [qc]);
}

function baseCache(qc: QueryClient) {
  const patch = (baseId: string, fn: (b: BaseWithTables) => BaseWithTables) =>
    qc.setQueryData<BaseWithTables>(qk.base(baseId), (old) => (old ? fn(old) : old));
  return {
    setView(baseId: string, view: View) {
      patch(baseId, (b) => ({
        ...b,
        tables: b.tables.map((t) =>
          t.id === view.tableId ? { ...t, views: (t.views ?? []).map((v) => (v.id === view.id ? view : v)) } : t,
        ),
      }));
    },
    setColumn(baseId: string, column: Column) {
      patch(baseId, (b) => ({
        ...b,
        tables: b.tables.map((t) =>
          t.id === column.tableId
            ? {
                ...t,
                columns: t.columns.some((c) => c.id === column.id)
                  ? t.columns.map((c) => (c.id === column.id ? column : c))
                  : [...t.columns, column],
              }
            : t,
        ),
      }));
    },
    setTable(baseId: string, table: Table) {
      patch(baseId, (b) => ({ ...b, tables: b.tables.map((t) => (t.id === table.id ? { ...t, ...table } : t)) }));
    },
    setBase(base: Base) {
      qc.setQueryData<Base[]>(qk.bases, (old) => old?.map((b) => (b.id === base.id ? { ...b, ...base } : b)));
      patch(base.id, (b) => ({ ...b, ...base, tables: b.tables }));
    },
    invalidateBase(baseId: string) {
      return qc.invalidateQueries({ queryKey: qk.base(baseId) });
    },
  };
}
