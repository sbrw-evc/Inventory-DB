import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n';
import { GridRow } from './GridRow';
import { HEADER_HEIGHT, PAGE_SIZE, useGrid } from './gridContext';

const SECTION = 'main';
const OVERSCAN = 8;

export function useRecordsInfinite(extraKey: unknown[], filterOverride?: Parameters<ReturnType<typeof useGrid>['source']['list']>[0]['filter'], pageSize = PAGE_SIZE) {
  const g = useGrid();
  const q = { ...g.baseQuery, filter: filterOverride ?? g.baseQuery.filter };
  return useInfiniteQuery({
    queryKey: [...g.source.key, 'list', JSON.stringify(q), ...extraKey, pageSize],
    queryFn: ({ pageParam, signal }) => g.source.list({ ...q, offset: pageParam, limit: pageSize }, signal),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.pageInfo.isLastPage || last.list.length === 0 ? undefined : last.pageInfo.offset + last.list.length,
  });
}

/** Ungrouped grid body: windowed rendering + infinite loading by offset/limit. */
export function FlatBody({ scrollTop, viewportHeight, onTotal }: { scrollTop: number; viewportHeight: number; onTotal: (n: number | null) => void }) {
  const g = useGrid();
  const query = useRecordsInfinite([]);
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.list) ?? [], [query.data]);
  const total = query.data?.pages[0]?.pageInfo.totalRows ?? rows.length;
  g.registerSection(SECTION, rows);

  useEffect(() => onTotal(query.data ? total : null), [total, query.data, onTotal]);

  const rh = g.rowHeight;
  const bodyTop = Math.max(0, scrollTop - HEADER_HEIGHT);
  const start = Math.max(0, Math.floor(bodyTop / rh) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((bodyTop + viewportHeight) / rh) + OVERSCAN);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && end >= rows.length - OVERSCAN * 2) void fetchNextPage();
  }, [end, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (query.isLoading) {
    return (
      <div className="grid-loading">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton-row" style={{ height: rh }} />
        ))}
      </div>
    );
  }
  if (query.isError) return <div className="grid-empty error-text">{(query.error as Error).message}</div>;

  // Reserve space for every row the server reported so the scrollbar reflects the full table.
  const reserved = Math.max(rows.length, hasNextPage ? total : rows.length);
  const active = g.active?.section === SECTION ? g.active : null;
  return (
    <>
      <div style={{ height: reserved * rh, position: 'relative' }}>
        {rows.slice(start, end).map((row, i) => {
          const idx = start + i;
          return (
            <GridRow
              key={row.id}
              section={SECTION}
              row={row}
              rowIndex={idx}
              displayIndex={idx + 1}
              style={{ position: 'absolute', top: idx * rh, left: 0, right: 0 }}
              activeCol={active?.row === idx ? active.col : null}
              editing={active?.row === idx ? g.editing : null}
              selected={g.selected.has(row.id)}
            />
          );
        })}
        {isFetchingNextPage && end >= rows.length && (
          <div className="grid-loading-more" style={{ top: rows.length * rh }}>
            {t('Loading…')}
          </div>
        )}
      </div>
      {g.perms.canEdit && (
        <button className="grid-add-row" style={{ width: g.totalWidth }} onClick={() => g.addRow()}>
          <Icon name="plus" size={14} /> {t('New record')}
        </button>
      )}
      {!rows.length && !g.perms.canEdit && <div className="grid-empty">{t('No records')}</div>}
    </>
  );
}
