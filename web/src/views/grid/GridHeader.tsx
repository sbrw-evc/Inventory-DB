import { useRef, useState } from 'react';
import type { Column, Sort } from '@shared';
import { FieldIcon, Icon } from '../../components/Icon';
import { MenuDivider, MenuItem, Popover } from '../../components/Popover';
import { t } from '../../i18n';
import type { ResolvedColumn } from '../../lib/viewColumns';
import { HEADER_HEIGHT, NUM_COL_WIDTH } from './gridContext';

export interface ColumnActions {
  onEdit: (c: Column) => void;
  onInsert: (c: Column, side: 'left' | 'right') => void;
  onHide: (c: Column) => void;
  onSort: (c: Column, dir: Sort['direction']) => void;
  onGroup: (c: Column) => void;
  onDelete: (c: Column) => void;
  onResize: (c: Column, width: number, done: boolean) => void;
  onAddField: () => void;
}

interface Props {
  columns: ResolvedColumn[];
  sorts: Sort[];
  canEditSchema: boolean;
  canEditView: boolean;
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: (on: boolean) => void;
  actions: ColumnActions;
}

function HeaderCell({ rc, sticky, sort, canEditSchema, canEditView, actions }: {
  rc: ResolvedColumn;
  sticky: boolean;
  sort?: Sort;
  canEditSchema: boolean;
  canEditView: boolean;
  actions: ColumnActions;
}) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const c = rc.column;
  const close = () => setMenu(false);
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = rc.width;
    const widthAt = (x: number) => Math.max(60, Math.min(800, startW + x - startX));
    const move = (ev: MouseEvent) => actions.onResize(c, widthAt(ev.clientX), false);
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      actions.onResize(c, widthAt(ev.clientX), true);
    };
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      ref={ref}
      className={`grid-hcell ${sticky ? 'sticky-col primary-col' : ''} ${menu ? 'menu-open' : ''}`}
      style={{ width: rc.width, ...(sticky ? { left: NUM_COL_WIDTH } : {}) }}
      title={c.description || c.title}
    >
      <button className="hcell-main" onClick={() => setMenu(true)}>
        <FieldIcon type={c.type} />
        <span className="hcell-title">{c.title}</span>
        {c.required && <span className="required-mark">*</span>}
        {sort && <Icon name={sort.direction === 'asc' ? 'arrowUp' : 'arrowDown'} size={12} className="sort-indicator" />}
        <Icon name="chevronDown" size={12} className="hcell-chevron" />
      </button>
      {canEditView && <span className="resize-handle" onMouseDown={startResize} />}
      {menu && (
        <Popover anchor={ref} onClose={close} className="menu">
          {canEditSchema && (
            <>
              <MenuItem icon={<Icon name="edit" />} onClick={run(() => actions.onEdit(c))}>
                {t('Edit field')}
              </MenuItem>
              <MenuItem icon={<Icon name="insertLeft" />} onClick={run(() => actions.onInsert(c, 'left'))}>
                {t('Insert left')}
              </MenuItem>
              <MenuItem icon={<Icon name="insertRight" />} onClick={run(() => actions.onInsert(c, 'right'))}>
                {t('Insert right')}
              </MenuItem>
              <MenuDivider />
            </>
          )}
          {canEditView && (
            <>
              <MenuItem icon={<Icon name="arrowUp" />} onClick={run(() => actions.onSort(c, 'asc'))}>
                {t('Sort ascending')}
              </MenuItem>
              <MenuItem icon={<Icon name="arrowDown" />} onClick={run(() => actions.onSort(c, 'desc'))}>
                {t('Sort descending')}
              </MenuItem>
              {c.type !== 'Links' && c.type !== 'Attachment' && c.type !== 'JSON' && (
                <MenuItem icon={<Icon name="group" />} onClick={run(() => actions.onGroup(c))}>
                  {t('Group by this field')}
                </MenuItem>
              )}
              {!c.primary && (
                <MenuItem icon={<Icon name="eyeOff" />} onClick={run(() => actions.onHide(c))}>
                  {t('Hide field')}
                </MenuItem>
              )}
            </>
          )}
          {canEditSchema && !c.primary && c.type !== 'ID' && (
            <>
              <MenuDivider />
              <MenuItem icon={<Icon name="trash" />} danger onClick={run(() => actions.onDelete(c))}>
                {t('Delete field')}
              </MenuItem>
            </>
          )}
          {!canEditSchema && !canEditView && <div className="empty-hint">{c.description || t('No actions available')}</div>}
        </Popover>
      )}
    </div>
  );
}

export function GridHeader({ columns, sorts, canEditSchema, canEditView, allSelected, someSelected, onToggleAll, actions }: Props) {
  return (
    <div className="grid-header" style={{ height: HEADER_HEIGHT }}>
      <div className="grid-hcell num-cell sticky-col" style={{ width: NUM_COL_WIDTH, left: 0 }}>
        {canEditSchema || someSelected ? (
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected && !allSelected;
            }}
            onChange={(e) => onToggleAll(e.target.checked)}
            aria-label={t('Select all')}
          />
        ) : (
          '#'
        )}
      </div>
      {columns.map((rc, i) => (
        <HeaderCell
          key={rc.column.id}
          rc={rc}
          sticky={i === 0}
          sort={sorts.find((s) => s.columnId === rc.column.id)}
          canEditSchema={canEditSchema}
          canEditView={canEditView}
          actions={actions}
        />
      ))}
      {canEditSchema ? (
        <button className="grid-hcell add-col" onClick={actions.onAddField} title={t('Add field')}>
          <Icon name="plus" size={15} />
        </button>
      ) : (
        <div className="grid-hcell filler-cell" />
      )}
    </div>
  );
}
