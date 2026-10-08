import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { Column, ListQuery, RecordData, Table, View } from '@shared';
import { qk } from '../api/hooks';
import { Icon } from '../components/Icon';
import { getLang, t } from '../i18n';
import { recordTitle } from '../lib/baseContext';
import { chipStyle, choiceColor } from '../lib/colors';
import { andFilters } from '../lib/filters';
import { parseYmd, toDateInput, ymd } from '../lib/format';
import { patchCachedRecord, type RecordSource, useRecordMutations } from '../lib/records';
import type { Permissions } from '../lib/roles';

interface Props {
  table: Table;
  view: View;
  source: RecordSource;
  baseQuery: ListQuery;
  perms: Permissions;
  onOpen: (id: number) => void;
  onAdd: (defaults: Record<string, unknown>) => void;
}

const DRAG_MIME = 'application/x-inventorydb-record';

function startOfGrid(month: Date): Date {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const dow = (first.getDay() + 6) % 7; // Monday first
  return new Date(first.getFullYear(), first.getMonth(), 1 - dow);
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Local day key of a stored Date/DateTime value. */
function dayKey(column: Column, v: unknown): string | null {
  if (!v) return null;
  if (column.type === 'Date') return toDateInput(v) || null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : ymd(d);
}

/** Moves a value to another day, keeping the time of day for DateTime fields. */
function moveToDay(column: Column, v: unknown, day: string): string {
  if (column.type === 'Date') return day;
  const target = parseYmd(day)!;
  const old = v ? new Date(String(v)) : null;
  if (old && !Number.isNaN(old.getTime())) target.setHours(old.getHours(), old.getMinutes(), old.getSeconds());
  else target.setHours(9, 0, 0);
  return target.toISOString();
}

export function CalendarView({ table, view, source, baseQuery, perms, onOpen, onAdd }: Props) {
  const qc = useQueryClient();
  const muts = useRecordMutations(table.id);
  const [month, setMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [overDay, setOverDay] = useState<string | null>(null);
  const dateCols = table.columns.filter((c) => ['Date', 'DateTime', 'CreatedTime', 'LastModifiedTime'].includes(c.type));
  const column = table.columns.find((c) => c.id === view.meta.dateColumnId) ?? dateCols[0];
  const colorCol = table.columns.find((c) => c.type === 'SingleSelect');
  const editableDate = !!column && (column.type === 'Date' || column.type === 'DateTime') && perms.canEdit;

  const gridStart = startOfGrid(month);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const rangeFilter = column
    ? {
        logic: 'and' as const,
        children: [
          { columnId: column.id, op: 'gte' as const, value: ymd(days[0]) },
          { columnId: column.id, op: 'lt' as const, value: ymd(addDays(days[41], 1)) },
        ],
      }
    : undefined;
  const filter = andFilters(baseQuery.filter, rangeFilter);
  const query = useQuery({
    queryKey: [...source.key, 'calendar', column?.id, ymd(days[0]), JSON.stringify(baseQuery)],
    queryFn: ({ signal }) => source.list({ ...baseQuery, filter, offset: 0, limit: 1000 }, signal),
    enabled: !!column,
  });

  const byDay = useMemo(() => {
    const m = new Map<string, RecordData[]>();
    if (!column) return m;
    for (const r of query.data?.list ?? []) {
      const k = dayKey(column, r[column.id]);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  }, [query.data, column]);

  if (!column) {
    return (
      <div className="empty-state">
        <Icon name="calendar" size={32} />
        <h3>{t('Calendar needs a date field')}</h3>
        <p className="muted">{t('Add a Date or Date time field to this table to place records on the calendar.')}</p>
      </div>
    );
  }

  const today = ymd(new Date());
  const lang = getLang();
  const weekdays = Array.from({ length: 7 }, (_, i) => addDays(gridStart, i).toLocaleDateString(lang, { weekday: 'short' }));

  const drop = async (day: string, e: React.DragEvent) => {
    e.preventDefault();
    setOverDay(null);
    const id = Number(e.dataTransfer.getData(DRAG_MIME));
    const row = query.data?.list.find((r) => r.id === id);
    if (!row || !editableDate) return;
    const value = moveToDay(column, row[column.id], day);
    patchCachedRecord(qc, table.id, id, { [column.id]: value });
    await muts.updateRecord(id, { [column.id]: value });
    await qc.invalidateQueries({ queryKey: qk.records(table.id) });
  };

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button className="btn btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label={t('Previous month')}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <button className="btn btn-sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
          {t('Today')}
        </button>
        <button className="btn btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label={t('Next month')}>
          <Icon name="chevronRight" size={14} />
        </button>
        <h3 className="calendar-title">{month.toLocaleDateString(lang, { month: 'long', year: 'numeric' })}</h3>
        <span className="muted small">
          {t('By')} {column.title}
        </span>
        {query.isFetching && <span className="muted small">{t('Loading…')}</span>}
      </div>
      <div className="calendar-grid">
        {weekdays.map((w) => (
          <div key={w} className="calendar-weekday">
            {w}
          </div>
        ))}
        {days.map((d) => {
          const key = ymd(d);
          const items = byDay.get(key) ?? [];
          const inMonth = d.getMonth() === month.getMonth();
          return (
            <div
              key={key}
              className={`calendar-day ${inMonth ? '' : 'other-month'} ${key === today ? 'today' : ''} ${overDay === key ? 'drag-over' : ''}`}
              onDragOver={(e) => {
                if (!editableDate) return;
                e.preventDefault();
                setOverDay(key);
              }}
              onDragLeave={() => setOverDay((o) => (o === key ? null : o))}
              onDrop={(e) => drop(key, e)}
              onDoubleClick={() => editableDate && onAdd({ [column.id]: moveToDay(column, null, key) })}
            >
              <div className="calendar-day-head">
                <span className="calendar-date">{d.getDate()}</span>
                {editableDate && (
                  <button className="icon-btn calendar-add" title={t('New record')} onClick={() => onAdd({ [column.id]: moveToDay(column, null, key) })}>
                    <Icon name="plus" size={12} />
                  </button>
                )}
              </div>
              <div className="calendar-items">
                {items.map((r) => {
                  const sel = colorCol ? r[colorCol.id] : null;
                  const style = sel ? chipStyle(choiceColor(colorCol!, String(sel))) : undefined;
                  return (
                    <div
                      key={r.id}
                      className="calendar-item"
                      style={style}
                      draggable={editableDate}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_MIME, String(r.id));
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(r.id);
                      }}
                      title={recordTitle(table, r)}
                    >
                      {column.type !== 'Date' && r[column.id] ? (
                        <span className="calendar-time">
                          {new Date(String(r[column.id])).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      ) : null}
                      {recordTitle(table, r)}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
