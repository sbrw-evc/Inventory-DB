import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import type { FilterGroup, Sort, Table, View } from '@shared';
import { type BaseWithTables } from '../api/endpoints';
import { qk, useBaseCache } from '../api/hooks';
import { ExpandedRecord } from '../components/ExpandedRecord';
import { ViewToolbar } from '../components/toolbar/ViewToolbar';
import { t } from '../i18n';
import { filterKey } from '../lib/filters';
import { apiSource } from '../lib/records';
import { permissionsFor } from '../lib/roles';
import { useDebounced } from '../lib/useDebounced';
import { resolveViewColumns, toViewColumns } from '../lib/viewColumns';
import { GalleryView } from '../views/GalleryView';
import { GridView } from '../views/grid/GridView';
import { KanbanView } from '../views/KanbanView';
import { CalendarView, FormBuilder, MapView, TimelineView } from '../views/lazyViews';
import { useViewState } from '../views/useViewState';

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Hosts one view of a table: toolbar + the view body + expanded record panel. */
export function TableViewPage({ base }: { base: BaseWithTables }) {
  const { tableId, viewId } = useParams();
  const table = base.tables.find((tb) => tb.id === tableId);
  const views = table?.views ?? [];
  const view = views.find((v) => v.id === viewId);
  if (!table) return <Navigate to={`/base/${base.id}`} replace />;
  if (!view) {
    const first = [...views].sort((a, b) => a.order - b.order)[0];
    return first ? <Navigate to={`/base/${base.id}/table/${table.id}/view/${first.id}`} replace /> : <div className="empty-state">{t('This table has no views')}</div>;
  }
  return <ViewHost key={view.id} base={base} table={table} view={view} />;
}

function ViewHost({ base, table, view }: { base: BaseWithTables; table: Table; view: View }) {
  const qc = useQueryClient();
  const cache = useBaseCache();
  const perms = permissionsFor(base.role);
  const canPersist = perms.canEdit && !view.locked;
  const { draft, update, saving } = useViewState(base.id, view, canPersist);
  const [params, setParams] = useSearchParams();
  const [total, setTotal] = useState<number | null>(null);

  const search = params.get('search') ?? '';
  const debouncedSearch = useDebounced(search, 300);
  const urlFilter = parseJson<FilterGroup>(params.get('filter'));
  const urlSorts = parseJson<Sort[]>(params.get('sorts'));
  const recordParam = params.get('record');
  const [newRecord, setNewRecord] = useState<Record<string, unknown> | null>(null);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Persisted mode edits the view; otherwise filters/sorts live only in the URL.
  const effectiveFilter = canPersist ? draft.filter : urlFilter;
  const effectiveSorts = canPersist ? draft.sorts ?? [] : urlSorts ?? draft.sorts ?? [];
  const onFilter = (f: FilterGroup | null) => (canPersist ? update({ filter: f }) : setParam('filter', f ? JSON.stringify(f) : null));
  const onSorts = (s: Sort[]) => (canPersist ? update({ sorts: s }) : setParam('sorts', s.length ? JSON.stringify(s) : null));

  // Records are keyed by the *saved* view settings, so they refetch once a change is stored.
  const source = useMemo(() => {
    const s = apiSource(table.id, view.id);
    return { ...s, key: [...s.key, filterKey(view.filter), JSON.stringify(view.sorts ?? [])] };
  }, [table.id, view.id, view.filter, view.sorts]);
  const baseQuery = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      filter: canPersist ? undefined : urlFilter ?? undefined,
      sorts: canPersist ? undefined : urlSorts ?? undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debouncedSearch, canPersist, params.get('filter'), params.get('sorts')],
  );

  const resolved = useMemo(() => resolveViewColumns(table.columns, draft.columns, draft.type), [table.columns, draft.columns, draft.type]);
  const openRecord = useCallback((id: number) => setParam('record', String(id)), [setParam]);
  const onColumnsChanged = useCallback(() => void cache.invalidateBase(base.id), [cache, base.id]);

  let body: React.ReactNode;
  switch (draft.type) {
    case 'grid':
      body = (
        <GridView
          table={table}
          view={draft}
          resolved={resolved}
          sorts={effectiveSorts}
          source={source}
          baseQuery={baseQuery}
          perms={perms}
          canEditView={canPersist}
          actions={{
            setColumns: (next) => update({ columns: toViewColumns(next) }),
            setSorts: onSorts,
            setGroupBy: (g) => update({ meta: { groupBy: g } }),
          }}
          onExpand={openRecord}
          onTotal={setTotal}
          onColumnsChanged={onColumnsChanged}
        />
      );
      break;
    case 'gallery':
      body = <GalleryView table={table} view={draft} resolved={resolved} source={source} baseQuery={baseQuery} onOpen={openRecord} onTotal={setTotal} />;
      break;
    case 'kanban':
      body = (
        <KanbanView
          table={table}
          view={draft}
          resolved={resolved}
          source={source}
          baseQuery={baseQuery}
          perms={perms}
          onOpen={openRecord}
          onAdd={(d) => setNewRecord(d)}
          onChooseField={(id) => update({ meta: { groupColumnId: id } })}
          onStackOrder={canPersist ? (order) => update({ meta: { stackOrder: order } }, { immediate: true }) : undefined}
        />
      );
      break;
    case 'timeline':
      body = (
        <TimelineView
          table={table}
          view={draft}
          source={source}
          baseQuery={baseQuery}
          perms={perms}
          onOpen={openRecord}
          onAdd={(d) => setNewRecord(d)}
          onScale={canPersist ? (s) => update({ meta: { timelineScale: s } }, { immediate: true }) : undefined}
        />
      );
      break;
    case 'map':
      body = <MapView table={table} view={draft} resolved={resolved} source={source} baseQuery={baseQuery} onOpen={openRecord} />;
      break;
    case 'calendar':
      body = <CalendarView table={table} view={draft} source={source} baseQuery={baseQuery} perms={perms} onOpen={openRecord} onAdd={(d) => setNewRecord(d)} />;
      break;
    case 'form':
      body = <FormBuilder table={table} view={draft} resolved={resolved} perms={perms} canEditView={canPersist} update={update} />;
      break;
  }

  return (
    <div className="view-host">
      <ViewToolbar
        baseId={base.id}
        table={table}
        view={draft}
        resolved={resolved}
        perms={perms}
        canPersist={canPersist}
        update={update}
        saving={saving}
        filter={effectiveFilter}
        sorts={effectiveSorts}
        onFilter={onFilter}
        onSorts={onSorts}
        search={search}
        onSearch={(s) => setParam('search', s)}
        total={draft.type === 'grid' || draft.type === 'gallery' ? total : null}
        onNewRecord={() => setNewRecord({})}
      />
      <div className="view-body">{body}</div>
      {recordParam && (
        <ExpandedRecord
          key={recordParam}
          table={table}
          recordId={Number(recordParam)}
          resolved={draft.type === 'form' ? undefined : resolved}
          onClose={() => setParam('record', null)}
        />
      )}
      {newRecord && (
        <ExpandedRecord
          table={table}
          recordId={null}
          defaults={newRecord}
          resolved={draft.type === 'form' ? undefined : resolved}
          onClose={() => {
            setNewRecord(null);
            void qc.invalidateQueries({ queryKey: qk.records(table.id) });
          }}
        />
      )}
    </div>
  );
}
