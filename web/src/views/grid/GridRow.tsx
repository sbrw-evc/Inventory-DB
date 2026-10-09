import { memo, useRef, type CSSProperties } from 'react';
import type { RecordData } from '@shared';
import { isFieldLocked, isFieldReadOnlyFor } from '@shared';
import { CellDisplay } from '../../cells/CellDisplay';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n';
import type { ResolvedColumn } from '../../lib/viewColumns';
import { GridEditor, INLINE_TYPES } from './GridEditor';
import { NUM_COL_WIDTH, useGrid } from './gridContext';

interface CellProps {
  section: string;
  rowIndex: number;
  colIndex: number;
  rc: ResolvedColumn;
  row: RecordData;
  left: number;
  sticky: boolean;
  isActive: boolean;
  isEditing: boolean;
  initialText?: string;
}

function GridCell({ section, rowIndex, colIndex, rc, row, left, sticky, isActive, isEditing, initialText }: CellProps) {
  const g = useGrid();
  const ref = useRef<HTMLDivElement>(null);
  const { column } = rc;
  const value = row[column.id];
  const canEdit = g.perms.canEdit && !isFieldLocked(column, g.perms.role);
  const lockedByPermission = g.perms.canEdit && isFieldReadOnlyFor(column, g.perms.role);
  const here = { section, row: rowIndex, col: colIndex };
  const inline = isEditing && INLINE_TYPES.has(column.type);
  const style: CSSProperties = { width: rc.width, ...(sticky ? { left } : {}) };
  return (
    <div
      ref={ref}
      className={`grid-cell ${sticky ? 'sticky-col primary-col' : ''} ${isActive ? 'active' : ''} ${isEditing ? 'editing' : ''} ${lockedByPermission ? 'cell-readonly' : ''}`}
      title={lockedByPermission && isActive ? t('Read-only field') : undefined}
      style={style}
      data-cell={`${section}:${rowIndex}:${colIndex}`}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        if (!isActive || !isEditing) g.setActive(here);
      }}
      onDoubleClick={() => {
        if (column.type === 'Checkbox' || column.type === 'Rating') return;
        g.startEditing(here);
      }}
    >
      {inline ? (
        <GridEditor
          column={column}
          value={value}
          initialText={initialText}
          anchor={ref.current}
          onCommit={(v, move) => g.commit(here, v, move)}
          onCancel={g.cancelEdit}
        />
      ) : (
        <>
          <div className="cell-content">
            <CellDisplay
              column={column}
              value={value}
              readOnly={!canEdit}
              wrap={g.rowHeight > 40}
              onQuickChange={(v) => {
                g.setActive(here);
                g.quickChange(row, column.id, v);
              }}
            />
          </div>
          {isEditing && (
            <GridEditor
              column={column}
              value={value}
              initialText={initialText}
              anchor={ref.current}
              onCommit={(v, move) => g.commit(here, v, move)}
              onCancel={g.cancelEdit}
            />
          )}
        </>
      )}
    </div>
  );
}

interface RowProps {
  section: string;
  row: RecordData;
  rowIndex: number;
  /** Row number shown (1-based, may differ from index in groups). */
  displayIndex: number;
  style?: CSSProperties;
  activeCol: number | null;
  editing: { initialText?: string } | null;
  selected: boolean;
}

export const GridRow = memo(function GridRow({ section, row, rowIndex, displayIndex, style, activeCol, editing, selected }: RowProps) {
  const g = useGrid();
  return (
    <div className={`grid-row ${selected ? 'selected' : ''} ${activeCol !== null ? 'has-active' : ''}`} style={{ height: g.rowHeight, ...style }}>
      <div className="grid-cell num-cell sticky-col" style={{ width: NUM_COL_WIDTH, left: 0 }}>
        <span className={`row-num ${selected ? 'hidden' : ''}`}>{displayIndex}</span>
        {(g.perms.canEdit || selected) && (
          <input
            type="checkbox"
            className={`row-check ${selected ? 'shown' : ''}`}
            checked={selected}
            onChange={(e) => g.toggleSelected(row.id, e.target.checked)}
            aria-label={t('Select row')}
          />
        )}
        <button className="row-expand" title={t('Expand record')} onClick={() => g.onExpand(row.id)}>
          <Icon name="expand" size={13} />
        </button>
      </div>
      {g.columns.map((rc, ci) => (
        <GridCell
          key={rc.column.id}
          section={section}
          rowIndex={rowIndex}
          colIndex={ci}
          rc={rc}
          row={row}
          left={NUM_COL_WIDTH}
          sticky={ci === 0}
          isActive={activeCol === ci}
          isEditing={activeCol === ci && !!editing}
          initialText={activeCol === ci ? editing?.initialText : undefined}
        />
      ))}
      <div className="grid-cell filler-cell" />
    </div>
  );
});
