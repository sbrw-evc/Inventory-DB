import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { Column, ListQuery, Table, View } from '@shared';
import { qk } from '../api/hooks';
import { Chip } from '../cells/CellDisplay';
import { Icon } from '../components/Icon';
import { t } from '../i18n';
import { andFilters, conditionForGroupValue } from '../lib/filters';
import { patchCachedRecord, type RecordSource, useRecordMutations } from '../lib/records';
import type { Permissions } from '../lib/roles';
import type { ResolvedColumn } from '../lib/viewColumns';
import { RecordCard } from './RecordCard';
import './kanbanStacks.css';

interface Props {
  table: Table;
  view: View;
  resolved: ResolvedColumn[];
  source: RecordSource;
  baseQuery: ListQuery;
  perms: Permissions;
  onOpen: (id: number) => void;
  onAdd: (defaults: Record<string, unknown>) => void;
  onChooseField: (columnId: string) => void;
  /** Persist a new stack order (drag stack headers); omitted when the view can't be changed. */
  onStackOrder?: (order: string[]) => void;
}

/** Stack being dragged by its header, and the stack it's over. */
interface StackDrag {
  dragging: string | null;
  over: string | null;
  setDragging: (s: string | null) => void;
  setOver: (s: string | null) => void;
  drop: (target: string) => void;
}

const DRAG_MIME = 'application/x-inventorydb-record';

function Stack({
  table,
  column,
  value,
  props,
  dragging,
  setDragging,
  stackDrag,
}: {
  table: Table;
  column: Column;
  value: string | null;
  props: Props;
  dragging: { id: number; from: string | null } | null;
  setDragging: (d: { id: number; from: string | null } | null) => void;
  stackDrag: StackDrag | null;
}) {
  const { source, baseQuery, resolved, perms, onOpen, onAdd } = props;
  const qc = useQueryClient();
  const muts = useRecordMutations(table.id);
  const [over, setOver] = useState(false);
  const filter = andFilters(baseQuery.filter, { logic: 'and', children: [conditionForGroupValue(column, value)] });
  const query = useInfiniteQuery({
    queryKey: [...source.key, 'kanban', column.id, value, JSON.stringify(baseQuery)],
    queryFn: ({ pageParam, signal }) => source.list({ ...baseQuery, filter, offset: pageParam, limit: 25 }, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.pageInfo.isLastPage || !last.list.length ? undefined : last.pageInfo.offset + last.list.length),
  });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.list) ?? [], [query.data]);
  const total = query.data?.pages[0]?.pageInfo.totalRows ?? 0;
  const cover = table.columns.find((c) => c.id === props.view.meta.coverColumnId);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const id = Number(e.dataTransfer.getData(DRAG_MIME));
    setDragging(null);
    if (!id || dragging?.from === value) return;
    patchCachedRecord(qc, table.id, id, { [column.id]: value });
    await muts.updateRecord(id, { [column.id]: value });
    await qc.invalidateQueries({ queryKey: qk.records(table.id) });
  };

  const movableStack = !!stackDrag && value !== null;
  const stackOver = !!stackDrag?.dragging && stackDrag.over === value && stackDrag.dragging !== value;
  return (
    <div
      className={`kanban-stack ${over ? 'drag-over' : ''} ${stackOver ? 'stack-drop-target' : ''} ${stackDrag?.dragging === value && value !== null ? 'stack-dragging' : ''}`}
      onDragOver={(e) => {
        if (stackDrag?.dragging && value !== null) {
          e.preventDefault();
          if (stackDrag.over !== value) stackDrag.setOver(value);
          return;
        }
        if (!dragging || !perms.canEdit) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        if (stackDrag?.dragging) {
          e.preventDefault();
          if (value !== null) stackDrag.drop(value);
          return;
        }
        void onDrop(e);
      }}
    >
      <div
        className={`kanban-stack-head ${movableStack ? 'stack-draggable' : ''}`}
        draggable={movableStack}
        title={movableStack ? t('Drag to reorder stacks') : undefined}
        onDragStart={(e) => {
          if (!movableStack) return;
          e.dataTransfer.setData('application/x-inventorydb-stack', value!);
          e.dataTransfer.effectAllowed = 'move';
          stackDrag!.setDragging(value);
        }}
        onDragEnd={() => {
          stackDrag?.setDragging(null);
          stackDrag?.setOver(null);
        }}
      >
        {movableStack && <Icon name="drag" size={13} className="muted" />}
        {value === null ? <span className="chip chip-empty">{t('Uncategorized')}</span> : <Chip column={column} title={value} />}
        <span className="group-count">{total}</span>
      </div>
      <div className="kanban-cards">
        {query.isLoading && <div className="empty-hint">{t('Loading…')}</div>}
        {rows.map((row) => (
          <RecordCard
            key={row.id}
            table={table}
            row={row}
            fields={resolved}
            cover={cover}
            maxFields={4}
            compact
            draggable={perms.canEdit}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_MIME, String(row.id));
              e.dataTransfer.effectAllowed = 'move';
              setDragging({ id: row.id, from: value });
            }}
            onOpen={() => onOpen(row.id)}
          />
        ))}
        {query.hasNextPage && (
          <button className="link-btn" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {t('Load more')}
          </button>
        )}
      </div>
      {perms.canEdit && (
        <button className="kanban-add" onClick={() => onAdd({ [column.id]: value })}>
          <Icon name="plus" size={13} /> {t('New record')}
        </button>
      )}
    </div>
  );
}

/** Kanban: one stack per option of a SingleSelect field (plus "Uncategorized"); drag cards between stacks. */
export function KanbanView(props: Props) {
  const { table, view, perms, onChooseField, onStackOrder } = props;
  const [dragging, setDragging] = useState<{ id: number; from: string | null } | null>(null);
  const [stackDragging, setStackDragging] = useState<string | null>(null);
  const [stackOver, setStackOver] = useState<string | null>(null);
  const selectCols = table.columns.filter((c) => c.type === 'SingleSelect');
  const column = table.columns.find((c) => c.id === view.meta.groupColumnId && c.type === 'SingleSelect') ?? selectCols[0];

  if (!column) {
    return (
      <div className="empty-state">
        <Icon name="kanban" size={32} />
        <h3>{t('Kanban needs a single select field')}</h3>
        <p className="muted">{t('Add a Single select field to this table to group records into stacks.')}</p>
      </div>
    );
  }
  const choices = (column.options.choices ?? []).map((c) => c.title);
  const order = view.meta.stackOrder?.filter((s) => choices.includes(s)) ?? [];
  const stacks: Array<string | null> = [null, ...order, ...choices.filter((c) => !order.includes(c))];
  const stackDrag: StackDrag | null = onStackOrder
    ? {
        dragging: stackDragging,
        over: stackOver,
        setDragging: setStackDragging,
        setOver: setStackOver,
        drop: (target) => {
          const moving = stackDragging;
          setStackDragging(null);
          setStackOver(null);
          if (!moving || moving === target) return;
          const current = stacks.filter((s): s is string => s !== null);
          const next = current.filter((s) => s !== moving);
          const from = current.indexOf(moving);
          const to = current.indexOf(target);
          next.splice(from < to ? next.indexOf(target) + 1 : next.indexOf(target), 0, moving);
          onStackOrder(next);
        },
      }
    : null;

  return (
    <div className="kanban-scroll" onDragEnd={() => setDragging(null)}>
      {!view.meta.groupColumnId && perms.canEdit && selectCols.length > 1 && (
        <div className="notice small kanban-note">
          {t('Stacked by “{name}”.', { name: column.title })}{' '}
          <button className="link-btn" onClick={() => onChooseField(column.id)}>
            {t('Keep this field')}
          </button>
        </div>
      )}
      <div className="kanban-board">
        {stacks.map((s) => (
          <Stack key={s ?? '__none'} table={table} column={column} value={s} props={props} dragging={dragging} setDragging={setDragging} stackDrag={stackDrag} />
        ))}
      </div>
    </div>
  );
}
