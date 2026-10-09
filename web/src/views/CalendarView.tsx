import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ListQuery, RecordData, Table, View } from '@shared';
import { isFieldLocked } from '@shared';
import { qk } from '../api/hooks';
import { Icon } from '../components/Icon';
import './calendarSpans.css';
import { getLang, t } from '../i18n';
import { recordTitle } from '../lib/baseContext';
import { chipStyle, choiceColor } from '../lib/colors';
import { andFilters } from '../lib/filters';
import { ymd } from '../lib/format';
import { addDays, DATE_FIELD_TYPES, daysBetween, EDITABLE_DATE_TYPES, moveToDay, overlapFilter, shiftDays, spanOf } from '../lib/dateSpan';
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

/** One record on one day; multi-day records (end date field) appear on every day they span. */
interface DayItem {
  row: RecordData;
  /** first / middle / last / single day of the span */
  part: 'single' | 'start' | 'middle' | 'end';
}

export function CalendarView({ table, view, source, baseQuery, perms, onOpen, onAdd }: Props) {
  const qc = useQueryClient();
  const muts = useRecordMutations(table.id);
  const [month, setMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [overDay, setOverDay] = useState<string | null>(null);
  const dateCols = table.columns.filter((c) => DATE_FIELD_TYPES.includes(c.type));
  const column = table.columns.find((c) => c.id === view.meta.dateColumnId) ?? dateCols[0];
  const endColumn = table.columns.find((c) => c.id === view.meta.endDateColumnId && c.id !== column?.id && DATE_FIELD_TYPES.includes(c.type));
  const colorCol = table.columns.find((c) => c.type === 'SingleSelect');
  const canWrite = (c: typeof column) => !!c && EDITABLE_DATE_TYPES.includes(c.type) && perms.canEdit && !isFieldLocked(c, perms.role);
  const editableDate = canWrite(column) && (!endColumn || canWrite(endColumn));

  const gridStart = startOfGrid(month);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const rangeFilter = column ? overlapFilter(column, endColumn, ymd(days[0]), ymd(addDays(days[41], 1))) : undefined;
  const filter = andFilters(baseQuery.filter, rangeFilter);
  const query = useQuery({
    queryKey: [...source.key, 'calendar', column?.id, endColumn?.id, ymd(days[0]), JSON.stringify(baseQuery)],
    queryFn: ({ signal }) => source.list({ ...baseQuery, filter, offset: 0, limit: 1000 }, signal),
    enabled: !!column,
  });

  const firstDay = ymd(days[0]);
  const byDay = useMemo(() => {
    const m = new Map<string, DayItem[]>();
    if (!column) return m;
    const gridStartDate = days[0];
    for (const r of query.data?.list ?? []) {
      const span = spanOf(r, column, endColumn);
      if (!span) continue;
      const total = daysBetween(span.start, span.end);
      // Only walk the days visible in the grid.
      const from = Math.max(0, daysBetween(span.start, gridStartDate));
      const to = Math.min(total, daysBetween(span.start, days[41]));
      for (let i = from; i <= to; i++) {
        const k = ymd(addDays(span.start, i));
        const part: DayItem['part'] = total === 0 ? 'single' : i === 0 ? 'start' : i === total ? 'end' : 'middle';
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push({ row: r, part });
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, column, endColumn, firstDay]);

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
    const [idRaw, fromDay] = e.dataTransfer.getData(DRAG_MIME).split('|');
    const id = Number(idRaw);
    const row = query.data?.list.find((r) => r.id === id);
    if (!row || !editableDate) return;
    // Multi-day records move by the distance between the day grabbed and the day dropped on.
    const span = spanOf(row, column, endColumn);
    const grabbed = fromDay ? new Date(`${fromDay}T00:00:00`) : span?.start;
    const delta = grabbed ? daysBetween(grabbed, new Date(`${day}T00:00:00`)) : 0;
    const patch: Record<string, unknown> = { [column.id]: span ? shiftDays(column, row[column.id], delta) : moveToDay(column, row[column.id], day) };
    if (endColumn && row[endColumn.id]) patch[endColumn.id] = shiftDays(endColumn, row[endColumn.id], delta);
    if (!delta && span) return;
    patchCachedRecord(qc, table.id, id, patch);
    await muts.updateRecord(id, patch);
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
                {items.map(({ row: r, part }) => {
                  const sel = colorCol ? r[colorCol.id] : null;
                  const style = sel ? chipStyle(choiceColor(colorCol!, String(sel))) : undefined;
                  return (
                    <div
                      key={r.id}
                      className={`calendar-item calendar-span-${part}`}
                      style={style}
                      draggable={editableDate}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_MIME, `${r.id}|${key}`);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(r.id);
                      }}
                      title={recordTitle(table, r)}
                    >
                      {column.type !== 'Date' && r[column.id] && (part === 'single' || part === 'start') ? (
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
