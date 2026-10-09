import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import type { Column, ListQuery, RecordData, Table, View, ViewMeta } from '@shared';
import { isFieldLocked } from '@shared';
import { dataApi } from '../api/endpoints';
import { qk } from '../api/hooks';
import { Chip } from '../cells/CellDisplay';
import { Icon } from '../components/Icon';
import { getLang, t } from '../i18n';
import { findTable, recordTitle, useBaseData } from '../lib/baseContext';
import { chipStyle, choiceColor } from '../lib/colors';
import { addDays, DATE_FIELD_TYPES, daysBetween, EDITABLE_DATE_TYPES, overlapFilter, shiftDays, spanOf } from '../lib/dateSpan';
import { andFilters } from '../lib/filters';
import { ymd } from '../lib/format';
import { patchCachedRecord, type RecordSource, useRecordMutations } from '../lib/records';
import type { Permissions } from '../lib/roles';
import './timeline.css';

type Scale = NonNullable<ViewMeta['timelineScale']>;

interface Props {
  table: Table;
  view: View;
  source: RecordSource;
  baseQuery: ListQuery;
  perms: Permissions;
  onOpen: (id: number) => void;
  onAdd: (defaults: Record<string, unknown>) => void;
  /** Persist the zoom level (omitted on read-only views: zoom is then local). */
  onScale?: (s: Scale) => void;
}

/** Pixels per day and number of days shown per zoom level. */
const SCALES: Record<Scale, { px: number; days: number; step: number }> = {
  day: { px: 64, days: 21, step: 7 },
  week: { px: 22, days: 84, step: 28 },
  month: { px: 6, days: 365, step: 91 },
};
const LABEL_WIDTH = 220;
const MAX_LANES = 50;

function startFor(scale: Scale, anchor: Date): Date {
  if (scale === 'month') return new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const dow = (anchor.getDay() + 6) % 7; // Monday first
  return addDays(anchor, -dow - (scale === 'week' ? 7 : 0));
}

interface Drag {
  id: number;
  mode: 'move' | 'start' | 'end';
  x0: number;
  delta: number;
}

/** Header ticks: days (day zoom), weeks (week zoom) or months (month zoom). */
function ticks(scale: Scale, from: Date, n: number): { offset: number; label: string; major?: boolean }[] {
  const lang = getLang();
  const out: { offset: number; label: string; major?: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const d = addDays(from, i);
    if (scale === 'day') out.push({ offset: i, label: d.toLocaleDateString(lang, { weekday: 'short', day: 'numeric' }), major: d.getDay() === 1 });
    else if (scale === 'week' && d.getDay() === 1) out.push({ offset: i, label: d.toLocaleDateString(lang, { day: 'numeric', month: 'short' }), major: d.getDate() <= 7 });
    else if (scale === 'month' && d.getDate() === 1) out.push({ offset: i, label: d.toLocaleDateString(lang, { month: 'short', year: d.getMonth() === 0 ? 'numeric' : undefined }), major: d.getMonth() === 0 });
  }
  return out;
}

/**
 * Timeline (Gantt-like): one bar per record from its start to its end date, optionally in swimlanes by a
 * single select or links field. Drag a bar to move it, drag its edges to change the dates.
 */
export function TimelineView({ table, view, source, baseQuery, perms, onOpen, onAdd, onScale }: Props) {
  const qc = useQueryClient();
  const muts = useRecordMutations(table.id);
  const { tables, isPublic } = useBaseData();
  const [localScale, setLocalScale] = useState<Scale>(view.meta.timelineScale ?? 'week');
  const scale = onScale ? (view.meta.timelineScale ?? 'week') : localScale;
  const setScale = (s: Scale) => (onScale ? onScale(s) : setLocalScale(s));
  const cfg = SCALES[scale];
  const [anchor, setAnchor] = useState(() => new Date());
  const from = startFor(scale, anchor);
  const to = addDays(from, cfg.days);
  const [drag, setDrag] = useState<Drag | null>(null);
  const moved = useRef(false);

  const dateCols = table.columns.filter((c) => DATE_FIELD_TYPES.includes(c.type));
  const start = table.columns.find((c) => c.id === view.meta.dateColumnId && DATE_FIELD_TYPES.includes(c.type)) ?? dateCols[0];
  const end = table.columns.find((c) => c.id === view.meta.endDateColumnId && c.id !== start?.id && DATE_FIELD_TYPES.includes(c.type));
  const lane = table.columns.find((c) => c.id === view.meta.groupColumnId && (c.type === 'SingleSelect' || (c.type === 'Links' && !isPublic)));
  const colorCol = lane?.type === 'SingleSelect' ? lane : table.columns.find((c) => c.type === 'SingleSelect');
  const writable = (c?: Column) => !!c && EDITABLE_DATE_TYPES.includes(c.type) && perms.canEdit && !isFieldLocked(c, perms.role);
  const canMove = writable(start) && (!end || writable(end));
  const canResizeEnd = !!end && writable(end);

  const filter = start ? andFilters(baseQuery.filter, overlapFilter(start, end, ymd(from), ymd(to))) : undefined;
  const query = useQuery({
    queryKey: [...source.key, 'timeline', start?.id, end?.id, ymd(from), scale, JSON.stringify(baseQuery)],
    queryFn: ({ signal }) => source.list({ ...baseQuery, filter, offset: 0, limit: 1000 }, signal),
    enabled: !!start,
  });
  const rows = useMemo(() => query.data?.list ?? [], [query.data]);

  // Links swimlanes: lanes are the related records; each lane lists the records linked to it.
  const related = lane?.type === 'Links' ? findTable(tables, lane.options.relatedTableId) : undefined;
  const laneRecords = useQuery({
    queryKey: ['records', related?.id ?? '', 'timeline-lanes'],
    queryFn: () => dataApi.list(related!.id, { limit: MAX_LANES }),
    enabled: !!related,
  });
  const symmetric = lane?.options.symmetricColumnId;
  const laneLinks = useQueries({
    queries: (laneRecords.data?.list ?? []).map((l) => ({
      queryKey: [...qk.links(related?.id ?? '', l.id, symmetric ?? ''), 'timeline', ''],
      queryFn: () => dataApi.listLinks(related!.id, l.id, symmetric!, { limit: 1000 }),
      enabled: !!related && !!symmetric,
    })),
  });

  type Lane = { key: string; label: React.ReactNode; rows: RecordData[] };
  const lanes: Lane[] = useMemo(() => {
    const sorted = [...rows].sort((a, b) => {
      const sa = start ? spanOf(a, start, end)?.start.getTime() ?? 0 : 0;
      const sb = start ? spanOf(b, start, end)?.start.getTime() ?? 0 : 0;
      return sa - sb || a.id - b.id;
    });
    if (!lane) return [{ key: 'all', label: null, rows: sorted }];
    if (lane.type === 'SingleSelect') {
      const titles = (lane.options.choices ?? []).map((c) => c.title);
      const out: Lane[] = titles.map((ti) => ({ key: ti, label: <Chip column={lane} title={ti} />, rows: sorted.filter((r) => r[lane.id] === ti) }));
      const none = sorted.filter((r) => !r[lane.id] || !titles.includes(String(r[lane.id])));
      out.unshift({ key: '__none', label: <span className="chip chip-empty">{t('Uncategorized')}</span>, rows: none });
      return out.filter((l) => l.rows.length || l.key !== '__none');
    }
    const byId = new Map(sorted.map((r) => [r.id, r]));
    const placed = new Set<number>();
    const out: Lane[] = (laneRecords.data?.list ?? []).map((l, i) => {
      const ids = (laneLinks[i]?.data?.list ?? []).map((r) => r.id);
      const laneRows = ids.map((id) => byId.get(id)).filter((r): r is RecordData => !!r);
      laneRows.forEach((r) => placed.add(r.id));
      laneRows.sort((a, b) => sorted.indexOf(a) - sorted.indexOf(b));
      return { key: String(l.id), label: <span className="chip chip-link">{recordTitle(related, l)}</span>, rows: laneRows };
    });
    const rest = sorted.filter((r) => !placed.has(r.id));
    if (rest.length) out.push({ key: '__none', label: <span className="chip chip-empty">{t('No linked record')}</span>, rows: rest });
    return out;
  }, [rows, lane, start, end, laneRecords.data, laneLinks, related]);

  if (!start) {
    return (
      <div className="empty-state">
        <Icon name="timeline" size={32} />
        <h3>{t('Timeline needs a date field')}</h3>
        <p className="muted">{t('Add a Date or Date time field to this table to place records on the timeline.')}</p>
      </div>
    );
  }

  const width = cfg.days * cfg.px;
  const todayOffset = daysBetween(from, new Date());
  const headTicks = ticks(scale, from, cfg.days);

  const commitDrag = async (row: RecordData, d: Drag) => {
    if (!d.delta) return;
    const patch: Record<string, unknown> = {};
    if (d.mode === 'move' || d.mode === 'start') patch[start.id] = shiftDays(start, row[start.id], d.delta);
    if (end && (d.mode === 'move' || d.mode === 'end')) {
      const base = row[end.id] ?? (d.mode === 'end' ? row[start.id] : null);
      if (base) patch[end.id] = shiftDays(end, base, d.delta);
    }
    if (d.mode === 'start' && end && row[end.id]) {
      const s = spanOf({ ...row, ...patch }, start);
      const e = spanOf(row, end);
      if (s && e && s.start > e.start) return; // start can't pass the end
    }
    if (d.mode === 'end') {
      const s = spanOf(row, start);
      const e = spanOf({ ...row, ...patch }, end!);
      if (s && e && e.start < s.start) return;
    }
    patchCachedRecord(qc, table.id, row.id, patch);
    await muts.updateRecord(row.id, patch);
  };

  const beginDrag = (e: React.PointerEvent, row: RecordData, mode: Drag['mode']) => {
    if (e.button !== 0) return;
    const allowed = mode === 'end' ? canResizeEnd : canMove;
    moved.current = false;
    if (!allowed) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: row.id, mode, x0: e.clientX, delta: 0 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.x0) / cfg.px);
    if (Math.abs(e.clientX - drag.x0) > 3) moved.current = true;
    if (delta !== drag.delta) setDrag({ ...drag, delta });
  };
  const onPointerUp = (row: RecordData) => {
    if (!drag || drag.id !== row.id) return;
    const d = drag;
    setDrag(null);
    void commitDrag(row, d);
  };

  const bar = (row: RecordData) => {
    const span = spanOf(row, start, end);
    if (!span) return null;
    let s = daysBetween(from, span.start);
    let e = daysBetween(from, span.end);
    if (drag?.id === row.id) {
      if (drag.mode !== 'end') s += drag.delta;
      if (drag.mode !== 'start') e += drag.delta;
      if (e < s) e = s;
    }
    const left = Math.max(0, s) * cfg.px;
    const right = Math.min(cfg.days, e + 1) * cfg.px;
    if (right <= 0 || left >= width) return null;
    const sel = colorCol ? row[colorCol.id] : null;
    const style = { left, width: Math.max(right - left, 4), ...(sel ? chipStyle(choiceColor(colorCol!, String(sel))) : {}) };
    const title = recordTitle(table, row);
    return (
      <div
        className={`timeline-bar ${canMove ? 'draggable' : ''} ${drag?.id === row.id ? 'dragging' : ''} ${s < 0 ? 'clipped-start' : ''} ${e >= cfg.days ? 'clipped-end' : ''}`}
        style={style}
        title={`${title} · ${span.start.toLocaleDateString(getLang())} – ${span.end.toLocaleDateString(getLang())}`}
        onPointerDown={(ev) => beginDrag(ev, row, 'move')}
        onPointerMove={onPointerMove}
        onPointerUp={() => onPointerUp(row)}
        onPointerCancel={() => setDrag(null)}
        onClick={() => {
          if (!moved.current) onOpen(row.id);
        }}
      >
        {canMove && s >= 0 && (
          <span className="timeline-handle start" onPointerDown={(ev) => beginDrag(ev, row, 'start')} onPointerMove={onPointerMove} onPointerUp={(ev) => { ev.stopPropagation(); onPointerUp(row); }} />
        )}
        <span className="timeline-bar-label">{title}</span>
        {canResizeEnd && e < cfg.days && (
          <span className="timeline-handle end" onPointerDown={(ev) => beginDrag(ev, row, 'end')} onPointerMove={onPointerMove} onPointerUp={(ev) => { ev.stopPropagation(); onPointerUp(row); }} />
        )}
      </div>
    );
  };

  const lang = getLang();
  const rangeLabel = `${from.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' })} – ${addDays(to, -1).toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const total = lanes.reduce((n, l) => n + l.rows.length, 0);

  return (
    <div className="timeline">
      <div className="timeline-head">
        <button className="btn btn-sm" onClick={() => setAnchor(addDays(anchor, -cfg.step))} aria-label={t('Earlier')}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <button className="btn btn-sm" onClick={() => setAnchor(new Date())}>
          {t('Today')}
        </button>
        <button className="btn btn-sm" onClick={() => setAnchor(addDays(anchor, cfg.step))} aria-label={t('Later')}>
          <Icon name="chevronRight" size={14} />
        </button>
        <h3 className="timeline-title">{rangeLabel}</h3>
        <div className="segmented" role="group" aria-label={t('Zoom')}>
          {(['day', 'week', 'month'] as Scale[]).map((s) => (
            <button key={s} className={`btn btn-sm ${scale === s ? 'is-active' : ''}`} aria-pressed={scale === s} onClick={() => setScale(s)}>
              {t(s === 'day' ? 'Days' : s === 'week' ? 'Weeks' : 'Months')}
            </button>
          ))}
        </div>
        <span className="muted small">
          {start.title}
          {end ? ` → ${end.title}` : ''}
        </span>
        {query.isFetching && <span className="muted small">{t('Loading…')}</span>}
        <span className="spacer" />
        {perms.canEdit && writable(start) && (
          <button className="btn btn-sm" onClick={() => onAdd({ [start.id]: start.type === 'Date' ? ymd(new Date()) : new Date().toISOString() })}>
            <Icon name="plus" size={13} /> {t('New record')}
          </button>
        )}
      </div>
      <div className="timeline-scroll">
        <div className="timeline-inner" style={{ width: LABEL_WIDTH + width }}>
          <div className="timeline-row timeline-axis">
            <div className="timeline-label" style={{ width: LABEL_WIDTH }}>
              {lane ? lane.title : t('Record')}
            </div>
            <div className="timeline-track" style={{ width }}>
              {headTicks.map((tk) => (
                <span key={tk.offset} className={`timeline-tick ${tk.major ? 'major' : ''}`} style={{ left: tk.offset * cfg.px }}>
                  {tk.label}
                </span>
              ))}
            </div>
          </div>
          {lanes.map((l) => (
            <div key={l.key} className="timeline-lane">
              {lane && (
                <div className="timeline-row timeline-lane-head">
                  <div className="timeline-label" style={{ width: LABEL_WIDTH }}>
                    {l.label} <span className="group-count">{l.rows.length}</span>
                  </div>
                  <div className="timeline-track" style={{ width }} />
                </div>
              )}
              {l.rows.map((r) => (
                <div key={r.id} className="timeline-row">
                  <button className="timeline-label link-like" style={{ width: LABEL_WIDTH }} onClick={() => onOpen(r.id)} title={recordTitle(table, r)}>
                    {recordTitle(table, r)}
                  </button>
                  <div className="timeline-track" style={{ width }}>
                    {headTicks.map((tk) => (
                      <span key={tk.offset} className={`timeline-grid ${tk.major ? 'major' : ''}`} style={{ left: tk.offset * cfg.px }} />
                    ))}
                    {todayOffset >= 0 && todayOffset < cfg.days && <span className="timeline-today" style={{ left: todayOffset * cfg.px + cfg.px / 2 }} />}
                    {bar(r)}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {!total && !query.isLoading && <div className="empty-hint timeline-empty">{t('No records in this period')}</div>}
        </div>
      </div>
    </div>
  );
}
