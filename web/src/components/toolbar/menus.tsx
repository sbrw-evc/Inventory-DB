import { useMemo, useState } from 'react';
import type { Column, FilterGroup, Sort, ViewMeta } from '@shared';
import { t } from '../../i18n';
import { cleanFilter, filterKey, withIds } from '../../lib/filters';
import { moveColumn, type ResolvedColumn } from '../../lib/viewColumns';
import { FieldIcon, Icon } from '../Icon';
import { FilterEditor } from './FilterEditor';

export function FieldsMenu({
  resolved,
  onChange,
  disabled,
  lockPrimary = true,
}: {
  resolved: ResolvedColumn[];
  onChange: (next: ResolvedColumn[]) => void;
  disabled?: boolean;
  lockPrimary?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const shown = resolved.filter((r) => r.column.title.toLowerCase().includes(search.toLowerCase()));
  const setAll = (show: boolean) => onChange(resolved.map((r) => (r.column.primary && lockPrimary ? r : { ...r, show })));
  return (
    <div className="fields-menu">
      <input className="input input-sm" placeholder={t('Search fields')} value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
      <div className="fields-list">
        {shown.map((r) => {
          const locked = r.column.primary && lockPrimary;
          return (
            <div
              key={r.column.id}
              className={`fields-item ${overId === r.column.id && dragId !== r.column.id ? 'drag-over' : ''} ${dragId === r.column.id ? 'dragging' : ''}`}
              draggable={!disabled && !locked && !search}
              onDragStart={(e) => {
                setDragId(r.column.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', r.column.id);
              }}
              onDragOver={(e) => {
                if (!dragId || locked) return;
                e.preventDefault();
                setOverId(r.column.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId && !locked) onChange(moveColumn(resolved, dragId, r.column.id));
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
            >
              <span className={`drag-handle ${locked || disabled ? 'invisible' : ''}`}>
                <Icon name="drag" size={14} />
              </span>
              <FieldIcon type={r.column.type} />
              <span className="fields-item-title">{r.column.title}</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={r.show}
                  disabled={disabled || locked}
                  onChange={(e) => onChange(resolved.map((x) => (x.column.id === r.column.id ? { ...x, show: e.target.checked } : x)))}
                />
                <span className="switch-track" />
              </label>
            </div>
          );
        })}
      </div>
      {!disabled && (
        <div className="menu-footer">
          <button className="link-btn" onClick={() => setAll(true)}>
            {t('Show all')}
          </button>
          <button className="link-btn" onClick={() => setAll(false)}>
            {t('Hide all')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Keeps the editing tree (with incomplete rows) locally and emits the cleaned filter when it changes. */
export function FilterMenu({
  value,
  columns,
  onChange,
  disabled,
  note,
}: {
  value: FilterGroup | null | undefined;
  columns: Column[];
  onChange: (f: FilterGroup | null) => void;
  disabled?: boolean;
  note?: string;
}) {
  const [tree, setTree] = useState<FilterGroup>(() => withIds(value));
  const sentKey = useMemo(() => filterKey(value), [value]);
  return (
    <div className="filter-menu">
      {note && <div className="notice small">{note}</div>}
      <FilterEditor
        root={tree}
        columns={columns}
        disabled={disabled}
        onChange={(next) => {
          setTree(next);
          if (filterKey(next) !== sentKey) onChange(cleanFilter(next));
        }}
      />
    </div>
  );
}

export function SortMenu({
  sorts,
  columns,
  onChange,
  disabled,
  max = 5,
  title,
}: {
  sorts: Sort[];
  columns: Column[];
  onChange: (s: Sort[]) => void;
  disabled?: boolean;
  max?: number;
  title?: string;
}) {
  const usable = columns.filter((c) => c.type !== 'Attachment' && c.type !== 'JSON' && c.type !== 'Links');
  const unused = usable.filter((c) => !sorts.some((s) => s.columnId === c.id));
  return (
    <div className="sort-menu">
      {title && <div className="menu-title">{title}</div>}
      {!sorts.length && <div className="empty-hint">{t('No sorting applied')}</div>}
      {sorts.map((s, i) => (
        <div key={s.columnId + i} className="sort-row">
          <select
            className="input input-sm"
            value={s.columnId}
            disabled={disabled}
            onChange={(e) => onChange(sorts.map((x, j) => (j === i ? { ...x, columnId: e.target.value } : x)))}
          >
            {usable
              .filter((c) => c.id === s.columnId || !sorts.some((x) => x.columnId === c.id))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
          </select>
          <select
            className="input input-sm"
            value={s.direction}
            disabled={disabled}
            onChange={(e) => onChange(sorts.map((x, j) => (j === i ? { ...x, direction: e.target.value as Sort['direction'] } : x)))}
          >
            <option value="asc">{t('A → Z')}</option>
            <option value="desc">{t('Z → A')}</option>
          </select>
          <button className="icon-btn" disabled={disabled} onClick={() => onChange(sorts.filter((_, j) => j !== i))} title={t('Remove')}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      {!disabled && sorts.length < max && unused.length > 0 && (
        <button className="link-btn" onClick={() => onChange([...sorts, { columnId: unused[0].id, direction: 'asc' }])}>
          <Icon name="plus" size={13} /> {title ? t('Add group') : t('Add sort')}
        </button>
      )}
    </div>
  );
}

export function RowHeightMenu({ value, onChange }: { value: ViewMeta['rowHeight']; onChange: (v: NonNullable<ViewMeta['rowHeight']>) => void }) {
  const opts: Array<{ v: NonNullable<ViewMeta['rowHeight']>; label: string }> = [
    { v: 'short', label: 'Short' },
    { v: 'medium', label: 'Medium' },
    { v: 'tall', label: 'Tall' },
  ];
  return (
    <div className="menu">
      {opts.map((o) => (
        <button key={o.v} className={`menu-item ${(value ?? 'short') === o.v ? 'selected' : ''}`} onClick={() => onChange(o.v)}>
          <span className="menu-item-icon">{(value ?? 'short') === o.v && <Icon name="check" size={13} />}</span>
          <span className="menu-item-label">{t(o.label)}</span>
        </button>
      ))}
    </div>
  );
}

/** Picker for a single column of given types (kanban stack field, calendar date field, cover). */
export function ColumnPicker({
  label,
  columns,
  value,
  onChange,
  allowNone,
  disabled,
}: {
  label: string;
  columns: Column[];
  value?: string;
  onChange: (id: string | undefined) => void;
  allowNone?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="column-picker">
      <div className="menu-title">{label}</div>
      {allowNone && (
        <button className={`menu-item ${!value ? 'selected' : ''}`} disabled={disabled} onClick={() => onChange(undefined)}>
          <span className="menu-item-icon">{!value && <Icon name="check" size={13} />}</span>
          <span className="menu-item-label muted">{t('None')}</span>
        </button>
      )}
      {columns.map((c) => (
        <button key={c.id} className={`menu-item ${value === c.id ? 'selected' : ''}`} disabled={disabled} onClick={() => onChange(c.id)}>
          <span className="menu-item-icon">{value === c.id ? <Icon name="check" size={13} /> : <FieldIcon type={c.type} />}</span>
          <span className="menu-item-label">{c.title}</span>
        </button>
      ))}
      {!columns.length && <div className="empty-hint">{t('No suitable fields in this table')}</div>}
    </div>
  );
}
