import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import type { ListQuery, Table, View } from '@shared';
import { t } from '../i18n';
import type { RecordSource } from '../lib/records';
import type { ResolvedColumn } from '../lib/viewColumns';
import { RecordCard } from './RecordCard';

interface Props {
  table: Table;
  view: View;
  resolved: ResolvedColumn[];
  source: RecordSource;
  baseQuery: ListQuery;
  onOpen: (id: number) => void;
  onTotal?: (n: number | null) => void;
}

export function GalleryView({ table, view, resolved, source, baseQuery, onOpen, onTotal }: Props) {
  const cover =
    table.columns.find((c) => c.id === view.meta.coverColumnId) ?? (view.meta.coverColumnId === undefined ? table.columns.find((c) => c.type === 'Attachment') : undefined);
  const query = useInfiniteQuery({
    queryKey: [...source.key, 'gallery', JSON.stringify(baseQuery)],
    queryFn: ({ pageParam, signal }) => source.list({ ...baseQuery, offset: pageParam, limit: 50 }, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.pageInfo.isLastPage || !last.list.length ? undefined : last.pageInfo.offset + last.list.length),
  });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.list) ?? [], [query.data]);
  const total = query.data?.pages[0]?.pageInfo.totalRows;
  useEffect(() => onTotal?.(total ?? null), [total, onTotal]);

  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (query.isLoading) return <div className="view-loading">{t('Loading…')}</div>;
  if (query.isError) return <div className="view-loading error-text">{(query.error as Error).message}</div>;
  return (
    <div className="gallery-scroll">
      {!rows.length && <div className="empty-state-sm">{t('No records')}</div>}
      <div className="gallery-grid">
        {rows.map((row) => (
          <RecordCard key={row.id} table={table} row={row} fields={resolved} cover={cover} onOpen={() => onOpen(row.id)} />
        ))}
      </div>
      <div ref={sentinel} className="gallery-sentinel">
        {isFetchingNextPage && t('Loading…')}
      </div>
    </div>
  );
}
