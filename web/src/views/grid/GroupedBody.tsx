import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { Column, FilterGroup, GroupResult, Sort } from '@shared';
import { Chip } from '../../cells/CellDisplay';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n';
import { andFilters, conditionForGroupValue } from '../../lib/filters';
import { asStringList, formatValue } from '../../lib/format';
import { GridRow } from './GridRow';
import { GROUP_PAGE_SIZE, useGrid } from './gridContext';
import { useRecordsInfinite } from './FlatBody';

interface GroupSpec {
  column: Column;
  direction: Sort['direction'];
}

function compareValues(a: unknown, b: unknown): number {
  const na = a === null || a === undefined || a === '';
  const nb = b === null || b === undefined || b === '';
  if (na || nb) return na === nb ? 0 : na ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function GroupLabel({ column, value }: { column: Column; value: unknown }) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length))
    return <span className="muted">{t('Empty')}</span>;
  if (column.type === 'SingleSelect' || column.type === 'MultiSelect') {
    return (
      <span className="chips">
        {asStringList(value).map((v) => (
          <Chip key={v} column={column} title={v} />
        ))}
      </span>
    );
  }
  return <span>{formatValue(column, value) || String(value)}</span>;
}

/** Defaults for a new row added inside a group, so it lands in that group. */
function defaultsFor(path: Array<{ column: Column; value: unknown }>) {
  const out: Record<string, unknown> = {};
  for (const { column, value } of path) {
    if (['Lookup', 'Rollup', 'Formula', 'Links', 'ID', 'CreatedTime', 'LastModifiedTime'].includes(column.type)) continue;
    out[column.id] = value;
  }
  return out;
}

function GroupRows({ sectionKey, filter, path }: { sectionKey: string; filter: FilterGroup; path: Array<{ column: Column; value: unknown }> }) {
  const g = useGrid();
  const query = useRecordsInfinite([sectionKey], andFilters(g.baseQuery.filter, filter), GROUP_PAGE_SIZE);
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.list) ?? [], [query.data]);
  g.registerSection(sectionKey, rows);
  const active = g.active?.section === sectionKey ? g.active : null;
  if (query.isLoading) return <div className="group-loading">{t('Loading…')}</div>;
  return (
    <div className="group-rows">
      {rows.map((row, idx) => (
        <GridRow
          key={row.id}
          section={sectionKey}
          row={row}
          rowIndex={idx}
          displayIndex={idx + 1}
          activeCol={active?.row === idx ? active.col : null}
          editing={active?.row === idx ? g.editing : null}
          selected={g.selected.has(row.id)}
        />
      ))}
      {query.hasNextPage && (
        <button className="grid-load-more" style={{ width: g.totalWidth }} onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
          {query.isFetchingNextPage ? t('Loading…') : t('Load more')}
        </button>
      )}
      {g.perms.canEdit && (
        <button className="grid-add-row" style={{ width: g.totalWidth }} onClick={() => g.addRow(defaultsFor(path))}>
          <Icon name="plus" size={14} /> {t('New record')}
        </button>
      )}
    </div>
  );
}

function GroupLevel({
  specs,
  level,
  parentFilter,
  path,
  collapsed,
  toggle,
}: {
  specs: GroupSpec[];
  level: number;
  parentFilter: FilterGroup | undefined;
  path: Array<{ column: Column; value: unknown }>;
  collapsed: Set<string>;
  toggle: (key: string, defaultOpen: boolean) => void;
}) {
  const g = useGrid();
  const spec = specs[level];
  const query = useQuery({
    queryKey: ['groups', g.table.id, ...g.source.key.slice(2), spec.column.id, JSON.stringify(parentFilter ?? null), JSON.stringify(g.baseQuery)],
    queryFn: ({ signal }) =>
      g.source.groups!({ columnId: spec.column.id, filter: andFilters(g.baseQuery.filter, parentFilter), search: g.baseQuery.search }, signal),
    enabled: !!g.source.groups,
  });
  const groups = useMemo(() => {
    const list = [...(query.data ?? [])];
    list.sort((a: GroupResult, b: GroupResult) => compareValues(a.value, b.value) * (spec.direction === 'desc' ? -1 : 1));
    return list;
  }, [query.data, spec.direction]);

  if (query.isLoading) return <div className="group-loading">{t('Loading groups…')}</div>;
  if (query.isError) return <div className="grid-empty error-text">{(query.error as Error).message}</div>;
  if (!groups.length) return <div className="grid-empty">{t('No records')}</div>;
  const defaultOpen = groups.length <= 10;

  return (
    <div className={`group-level level-${level}`}>
      {groups.map((grp) => {
        const key = [...path.map((p) => JSON.stringify(p.value)), JSON.stringify(grp.value)].join('/') + `@${level}`;
        const open = collapsed.has(key) ? !defaultOpen : defaultOpen;
        const cond = conditionForGroupValue(spec.column, grp.value);
        const filter = andFilters(parentFilter, { logic: 'and', children: [cond] })!;
        const nextPath = [...path, { column: spec.column, value: grp.value }];
        return (
          <div key={key} className={`group ${open ? 'open' : ''}`} style={{ marginLeft: level * 12 }}>
            <button className="group-header" onClick={() => toggle(key, defaultOpen)}>
              <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
              <span className="group-col">{spec.column.title}</span>
              <GroupLabel column={spec.column} value={grp.value} />
              <span className="group-count">{grp.count}</span>
            </button>
            {open &&
              (level < specs.length - 1 ? (
                <GroupLevel specs={specs} level={level + 1} parentFilter={filter} path={nextPath} collapsed={collapsed} toggle={toggle} />
              ) : (
                <GroupRows sectionKey={key} filter={filter} path={nextPath} />
              ))}
          </div>
        );
      })}
    </div>
  );
}

/** Grid body grouped by up to three columns (view.meta.groupBy), each group collapsible. */
export function GroupedBody({ specs }: { specs: GroupSpec[] }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  return <GroupLevel specs={specs} level={0} parentFilter={undefined} path={[]} collapsed={collapsed} toggle={toggle} />;
}
