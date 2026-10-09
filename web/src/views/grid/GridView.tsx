import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Column, ListQuery, RecordData, Sort, Table, View } from '@shared';
import { isFieldLocked } from '@shared';
import { metaApi } from '../../api/endpoints';
import { qk } from '../../api/hooks';
import { isChecked } from '../../cells/CellDisplay';
import { LinkPicker } from '../../cells/LinkPicker';
import { confirmDialog } from '../../components/dialogs';
import { FieldEditor } from '../../components/FieldEditor';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n';
import { parseInputValue, toClipboardText } from '../../lib/format';
import { type RecordSource, useRecordMutations } from '../../lib/records';
import type { Permissions } from '../../lib/roles';
import { toast, toastError } from '../../lib/toast';
import { type ResolvedColumn } from '../../lib/viewColumns';
import { FlatBody } from './FlatBody';
import { type Move, POPOVER_TYPES, INLINE_TYPES, TYPE_TO_EDIT } from './GridEditor';
import { GridHeader, type ColumnActions } from './GridHeader';
import { type ActiveCell, GridContext, type GridCtx, HEADER_HEIGHT, NUM_COL_WIDTH, ROW_HEIGHTS } from './gridContext';
import { GroupedBody } from './GroupedBody';

export interface GridViewActions {
  setColumns: (resolved: ResolvedColumn[]) => void;
  setSorts: (sorts: Sort[]) => void;
  setGroupBy: (groupBy: Sort[]) => void;
}

interface Props {
  table: Table;
  view: View;
  /** All columns (hidden included) in view order. */
  resolved: ResolvedColumn[];
  sorts: Sort[];
  source: RecordSource;
  baseQuery: ListQuery;
  perms: Permissions;
  canEditView: boolean;
  actions: GridViewActions;
  onExpand: (id: number) => void;
  onTotal?: (n: number | null) => void;
  onColumnsChanged?: () => void;
}

function emptyValue(c: Column): unknown {
  if (c.type === 'Checkbox') return false;
  if (c.type === 'MultiSelect' || c.type === 'Attachment') return [];
  return null;
}

export function GridView({ table, view, resolved, sorts, source, baseQuery, perms, canEditView, actions, onExpand, onTotal, onColumnsChanged }: Props) {
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const [active, setActiveState] = useState<ActiveCell | null>(null);
  const [editing, setEditing] = useState<{ initialText?: string } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [linkPicker, setLinkPicker] = useState<{ rowId: number; column: Column } | null>(null);
  const [fieldEditor, setFieldEditor] = useState<{ column?: Column; insert?: { anchor: Column; side: 'left' | 'right' } } | null>(null);
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const sections = useRef(new Map<string, RecordData[]>());
  const muts = useRecordMutations(table.id);

  const visible = useMemo(
    () => resolved.filter((r) => r.show).map((r) => (liveWidths[r.column.id] ? { ...r, width: liveWidths[r.column.id] } : r)),
    [resolved, liveWidths],
  );
  const offsets = useMemo(() => {
    let x = NUM_COL_WIDTH;
    return visible.map((r) => {
      const o = x;
      x += r.width;
      return o;
    });
  }, [visible]);
  const totalWidth = NUM_COL_WIDTH + visible.reduce((s, r) => s + r.width, 0);
  const rowHeight = ROW_HEIGHTS[view.meta.rowHeight ?? 'short'];
  const groupSpecs = useMemo(
    () =>
      (view.meta.groupBy ?? [])
        .map((gb) => ({ column: table.columns.find((c) => c.id === gb.columnId)!, direction: gb.direction }))
        .filter((s) => !!s.column)
        .slice(0, 3),
    [view.meta.groupBy, table.columns],
  );
  const grouped = groupSpecs.length > 0 && !!source.groups;

  // Reset transient state when switching views.
  useEffect(() => {
    setActiveState(null);
    setEditing(null);
    setSelected(new Set());
  }, [view.id]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setScroll({ top: el.scrollTop, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowsOf = (section: string) => sections.current.get(section) ?? [];
  const cellAt = (a: ActiveCell) => {
    const row = rowsOf(a.section)[a.row];
    const rc = visible[a.col];
    return row && rc ? { row, column: rc.column } : null;
  };

  const setActive = useCallback((a: ActiveCell | null) => {
    setActiveState(a);
    setEditing(null);
  }, []);

  // Keep the active cell visible (also for virtualized rows not yet rendered).
  useEffect(() => {
    if (!active) return;
    const el = scrollRef.current;
    if (!el) return;
    const node = el.querySelector<HTMLElement>(`[data-cell="${CSS.escape(`${active.section}:${active.row}:${active.col}`)}"]`);
    const stickyW = NUM_COL_WIDTH + (visible[0]?.width ?? 0);
    if (node) {
      const r = node.getBoundingClientRect();
      const c = el.getBoundingClientRect();
      if (r.top < c.top + HEADER_HEIGHT) el.scrollTop -= c.top + HEADER_HEIGHT - r.top;
      else if (r.bottom > c.bottom) el.scrollTop += r.bottom - c.bottom;
      if (active.col > 0) {
        if (r.left < c.left + stickyW) el.scrollLeft -= c.left + stickyW - r.left;
        else if (r.right > c.right) el.scrollLeft += r.right - c.right;
      }
    } else if (active.section === 'main') {
      el.scrollTop = Math.max(0, active.row * rowHeight - el.clientHeight / 2);
    }
    if (document.activeElement === document.body || !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, [active, rowHeight, visible]);

  const move = useCallback(
    (a: ActiveCell, dir: Exclude<Move, null | 'keep'>): ActiveCell => {
      const rows = sections.current.get(a.section)?.length ?? 0;
      switch (dir) {
        case 'down':
          return { ...a, row: Math.min(a.row + 1, Math.max(rows - 1, 0)) };
        case 'up':
          return { ...a, row: Math.max(a.row - 1, 0) };
        case 'right':
          return { ...a, col: Math.min(a.col + 1, visible.length - 1) };
        case 'left':
          return { ...a, col: Math.max(a.col - 1, 0) };
      }
    },
    [visible.length],
  );

  const canEditCell = (c: Column) => perms.canEdit && !isFieldLocked(c, perms.role);

  const startEditing = useCallback(
    (a: ActiveCell, initialText?: string) => {
      const cell = (() => {
        const row = sections.current.get(a.section)?.[a.row];
        const rc = visible[a.col];
        return row && rc ? { row, column: rc.column } : null;
      })();
      if (!cell) return;
      setActiveState(a);
      if (cell.column.type === 'Links') {
        setLinkPicker({ rowId: cell.row.id, column: cell.column });
        return;
      }
      if (!perms.canEdit || isFieldLocked(cell.column, perms.role)) return;
      if (cell.column.type === 'Checkbox') {
        void muts.updateCell(cell.row.id, cell.column.id, !isChecked(cell.row[cell.column.id]), cell.row[cell.column.id]);
        return;
      }
      if (INLINE_TYPES.has(cell.column.type) || POPOVER_TYPES.has(cell.column.type)) setEditing({ initialText });
    },
    [visible, perms.canEdit, muts],
  );

  const commit = useCallback(
    (a: ActiveCell, value: unknown, mv: Move) => {
      const row = sections.current.get(a.section)?.[a.row];
      const rc = visible[a.col];
      if (row && rc) {
        const prev = row[rc.column.id];
        if (JSON.stringify(prev ?? null) !== JSON.stringify(value ?? null)) void muts.updateCell(row.id, rc.column.id, value, prev);
      }
      if (mv === 'keep') return;
      setEditing(null);
      if (mv) setActiveState(move(a, mv));
      scrollRef.current?.focus({ preventScroll: true });
    },
    [visible, muts, move],
  );

  const addRow = useCallback(
    async (defaults: Record<string, unknown> = {}) => {
      const created = await muts.createRecord(defaults);
      if (!created) return;
      requestAnimationFrame(() => {
        for (const [section, rows] of sections.current) {
          const idx = rows.findIndex((r) => r.id === created.id);
          if (idx >= 0) {
            setActiveState({ section, row: idx, col: 0 });
            setEditing(null);
            return;
          }
        }
        onExpand(created.id);
      });
    },
    [muts, onExpand],
  );

  const toggleSelected = useCallback((id: number, on?: boolean) => {
    setSelected((s) => {
      const n = new Set(s);
      if (on ?? !n.has(id)) n.add(id);
      else n.delete(id);
      return n;
    });
  }, []);

  const ctx: GridCtx = {
    table,
    columns: visible,
    rowHeight,
    perms,
    source,
    baseQuery,
    active,
    editing,
    selected,
    offsets,
    totalWidth,
    registerSection: (key, rows) => sections.current.set(key, rows),
    setActive,
    startEditing,
    commit,
    cancelEdit: () => {
      setEditing(null);
      scrollRef.current?.focus({ preventScroll: true });
    },
    quickChange: (row, columnId, value) => {
      const col = table.columns.find((c) => c.id === columnId);
      if (!perms.canEdit || (col && isFieldLocked(col, perms.role))) return;
      void muts.updateCell(row.id, columnId, value, row[columnId]);
    },
    toggleSelected,
    onExpand,
    addRow: (d) => void addRow(d),
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== scrollRef.current) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      void muts.redo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      void muts.undo();
      return;
    }
    if (!active || editing) return;
    const cell = cellAt(active);
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        const dir = e.key.slice(5).toLowerCase() as 'down' | 'up' | 'left' | 'right';
        if (mod && (dir === 'up' || dir === 'down')) {
          const n = rowsOf(active.section).length;
          setActive({ ...active, row: dir === 'up' ? 0 : Math.max(n - 1, 0) });
        } else if (mod) setActive({ ...active, col: dir === 'left' ? 0 : visible.length - 1 });
        else setActive(move(active, dir));
        return;
      }
      case 'Tab':
        e.preventDefault();
        setActive(move(active, e.shiftKey ? 'left' : 'right'));
        return;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        startEditing(active);
        return;
      case 'Escape':
        setActive(null);
        return;
      case ' ':
        if (cell && cell.column.type !== 'Checkbox') {
          e.preventDefault();
          onExpand(cell.row.id);
        } else if (cell) {
          e.preventDefault();
          startEditing(active);
        }
        return;
      case 'Delete':
      case 'Backspace':
        if (cell && canEditCell(cell.column)) {
          e.preventDefault();
          void muts.updateCell(cell.row.id, cell.column.id, emptyValue(cell.column), cell.row[cell.column.id]);
        }
        return;
    }
    if (cell && !mod && !e.altKey && e.key.length === 1 && canEditCell(cell.column)) {
      if (cell.column.type === 'Rating' && /\d/.test(e.key)) {
        e.preventDefault();
        void muts.updateCell(cell.row.id, cell.column.id, Math.min(Number(e.key), cell.column.options.max ?? 5), cell.row[cell.column.id]);
      } else if (TYPE_TO_EDIT.has(cell.column.type)) {
        e.preventDefault();
        startEditing(active, e.key);
      }
    }
  };

  const onCopy = (e: React.ClipboardEvent) => {
    if (e.target !== scrollRef.current || !active || editing) return;
    const cell = cellAt(active);
    if (!cell) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', toClipboardText(cell.column, cell.row[cell.column.id]));
    toast(t('Copied'), 'info', 1200);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (e.target !== scrollRef.current || !active || editing || !perms.canEdit) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const block = lines.map((l) => l.split('\t'));
    const single = block.length === 1 && block[0].length === 1;
    const rows = rowsOf(active.section);
    let changed = 0;
    let skipped = 0;
    block.forEach((cells, ri) => {
      const row = rows[active.row + ri];
      if (!row) return;
      cells.forEach((txt, ci) => {
        const rc = visible[active.col + ci];
        if (!rc || !canEditCell(rc.column)) {
          skipped++;
          return;
        }
        const v = parseInputValue(rc.column, single ? text : txt);
        if (v === undefined) {
          skipped++;
          return;
        }
        changed++;
        void muts.updateCell(row.id, rc.column.id, v, row[rc.column.id]);
      });
    });
    if (!changed && skipped) toast(t('Nothing pasted: the value doesn’t fit this field'), 'error');
  };

  // Column actions from the header menu.
  const colActions: ColumnActions = {
    onEdit: (c) => setFieldEditor({ column: c }),
    onInsert: (c, side) => setFieldEditor({ insert: { anchor: c, side } }),
    onAddField: () => setFieldEditor({}),
    onHide: (c) => actions.setColumns(resolved.map((r) => (r.column.id === c.id ? { ...r, show: false } : r))),
    onSort: (c, direction) => actions.setSorts([{ columnId: c.id, direction }, ...sorts.filter((s) => s.columnId !== c.id)].slice(0, 5)),
    onGroup: (c) =>
      actions.setGroupBy([...(view.meta.groupBy ?? []).filter((g) => g.columnId !== c.id), { columnId: c.id, direction: 'asc' as const }].slice(-3)),
    onDelete: async (c) => {
      const ok = await confirmDialog({
        title: t('Delete field “{name}”?', { name: c.title }),
        message: t('All values in this field will be permanently deleted.'),
        confirmLabel: t('Delete'),
        danger: true,
      });
      if (!ok) return;
      try {
        await metaApi.deleteColumn(c.id);
        onColumnsChanged?.();
        void qc.invalidateQueries({ queryKey: qk.records(table.id) });
      } catch (err) {
        toastError(err);
      }
    },
    onResize: (c, width, done) => {
      if (!done) {
        setLiveWidths((w) => ({ ...w, [c.id]: width }));
        return;
      }
      setLiveWidths((w) => {
        const n = { ...w };
        delete n[c.id];
        return n;
      });
      actions.setColumns(resolved.map((r) => (r.column.id === c.id ? { ...r, width } : r)));
    },
  };

  const onFieldSaved = (col: Column) => {
    const ins = fieldEditor?.insert;
    const isNew = !fieldEditor?.column;
    if (isNew) {
      const entry: ResolvedColumn = { column: col, show: true, width: 170 };
      let next = resolved.filter((r) => r.column.id !== col.id);
      const anchorIdx = ins ? next.findIndex((r) => r.column.id === ins.anchor.id) : -1;
      if (anchorIdx >= 0) next.splice(ins!.side === 'left' ? Math.max(anchorIdx, 1) : anchorIdx + 1, 0, entry);
      else next = [...next, entry];
      actions.setColumns(next);
    }
    onColumnsChanged?.();
    void qc.invalidateQueries({ queryKey: qk.records(table.id) });
  };

  const loadedIds = [...sections.current.values()].flat().map((r) => r.id);
  const allSelected = loadedIds.length > 0 && loadedIds.every((id) => selected.has(id));

  const bulkDelete = async () => {
    const ids = [...selected];
    const ok = await confirmDialog({
      title: t('Delete {n} records?', { n: ids.length }),
      message: t('This can’t be undone.'),
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (!ok) return;
    if (await muts.deleteRecords(ids)) setSelected(new Set());
  };

  return (
    <GridContext.Provider value={ctx}>
      <div className="grid-wrap">
        {selected.size > 0 && (
          <div className="bulk-bar">
            <span>{t('Selected: {n}', { n: selected.size })}</span>
            {perms.canEdit && (
              <button className="btn btn-sm btn-danger-outline" onClick={bulkDelete}>
                <Icon name="trash" size={13} /> {t('Delete')}
              </button>
            )}
            <button className="btn btn-sm" onClick={() => setSelected(new Set())}>
              {t('Clear selection')}
            </button>
          </div>
        )}
        <div
          ref={scrollRef}
          className={`grid-scroll row-${view.meta.rowHeight ?? 'short'}`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onCopy={onCopy}
          onPaste={onPaste}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (Math.abs(el.scrollTop - scroll.top) > rowHeight / 2 || el.clientHeight !== scroll.height)
              setScroll({ top: el.scrollTop, height: el.clientHeight });
          }}
        >
          <div className="grid-canvas" style={{ minWidth: totalWidth + 60 }}>
            <GridHeader
              columns={visible}
              sorts={sorts}
              canEditSchema={perms.canEdit && !!source.groups}
              canEditView={canEditView}
              allSelected={allSelected}
              someSelected={selected.size > 0}
              onToggleAll={(on) => setSelected(on ? new Set(loadedIds) : new Set())}
              actions={colActions}
            />
            {grouped ? (
              <GroupedBody specs={groupSpecs} />
            ) : (
              <FlatBody scrollTop={scroll.top} viewportHeight={scroll.height} onTotal={onTotal ?? noop} />
            )}
          </div>
        </div>
      </div>
      {linkPicker && (
        <LinkPicker
          table={table}
          column={linkPicker.column}
          recordId={linkPicker.rowId}
          readOnly={!perms.canEdit}
          onClose={() => {
            setLinkPicker(null);
            scrollRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {fieldEditor && <FieldEditor table={table} column={fieldEditor.column} onClose={() => setFieldEditor(null)} onSaved={onFieldSaved} />}
    </GridContext.Provider>
  );
}

const noop = () => {};
