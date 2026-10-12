import { useCallback, useEffect, useRef, useState } from 'react';
import type { FlowTraffic } from '@shared';
import { ApiError, nb, request, toQuery, type Me, type ModelSchema, type NbObject } from './api';
import { normalizeMonitoring, type MonitoringStatus } from './format';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/** Runs `fn` when `deps` change; `reload()` runs it again. Stale responses are ignored. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => my === seq.current && setState({ data, loading: false }),
      (error: Error) => my === seq.current && setState({ error, loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

let schemaPromise: Promise<ModelSchema[]> | null = null;
export function loadSchema(): Promise<ModelSchema[]> {
  schemaPromise ??= nb.schema().then(
    (r) => r.results,
    (e) => {
      schemaPromise = null;
      throw e;
    },
  );
  return schemaPromise;
}

export function useSchema() {
  return useAsync(loadSchema, []);
}

export const findModel = (schema: ModelSchema[] | undefined, key: string) =>
  schema?.find((m) => m.object_type === key || m.path === key || `${m.app}/${m.path}` === key);

let mePromise: Promise<Me> | null = null;
export function useMe() {
  return useAsync(() => {
    mePromise ??= nb.me().catch((e) => {
      mePromise = null;
      throw e;
    });
    return mePromise;
  }, []);
}

/** Custom field definitions for an object type. */
export function useCustomFields(objectType: string | undefined) {
  return useAsync(async () => {
    if (!objectType) return [];
    const page = await request<{ results: NbObject[] }>('GET', `/extras/custom-fields${toQuery({ limit: 1000 })}`);
    return page.results.filter((cf) => ((cf.object_types as string[]) ?? []).includes(objectType));
  }, [objectType]);
}

/**
 * Monitoring status from the Umbrella integration. Returns `null` when the integration isn't installed (404) or
 * fails, so callers hide the column.
 */
export function useMonitoring(objectType: string, ids: number[]): Map<number, MonitoringStatus> | null {
  const key = ids.join(',');
  const { data } = useAsync(async () => {
    if (!ids.length) return new Map<number, MonitoringStatus>();
    try {
      const res = await request('GET', `/api/v1/integrations/umbrella/status${toQuery({ object_type: objectType, ids: key })}`);
      return normalizeMonitoring(res);
    } catch (e) {
      if (e instanceof ApiError) return null;
      return null;
    }
  }, [objectType, key]);
  return data ?? null;
}

/** Polls `reload` every `ms` while `on`. */
export function useInterval(cb: () => void, ms: number, on: boolean) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (!on) return;
    const h = setInterval(() => ref.current(), ms);
    return () => clearInterval(h);
  }, [ms, on]);
}

/**
 * Traffic from the Umbrella Flow integration (server-side proxy, contract §2.1). Returns `null` when no Flow
 * integration is active or Flow fails, so callers hide the column, chip or card.
 */
export function useFlowTraffic(objectType: 'dcim.device' | 'dcim.interface' | 'circuits.circuit', ids: number[]): Map<number, FlowTraffic> | null {
  const key = [...new Set(ids)].sort((a, b) => a - b).join(',');
  const { data } = useAsync(async () => {
    if (!key) return null;
    try {
      const res = await request<{ results?: Record<string, FlowTraffic> }>('GET', `/api/v1/integrations/flow/status${toQuery({ object_type: objectType, ids: key })}`);
      const out = new Map<number, FlowTraffic>();
      for (const [id, v] of Object.entries(res?.results ?? {})) if (v && typeof v === 'object') out.set(Number(id), v);
      return out;
    } catch {
      return null;
    }
  }, [objectType, key]);
  return data ?? null;
}
