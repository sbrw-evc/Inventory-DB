import type { Column, RecordData, Table } from '@shared';
import { CellDisplay } from '../cells/CellDisplay';
import { Icon } from '../components/Icon';
import { recordTitle } from '../lib/baseContext';
import { asAttachments, isImage } from '../lib/format';
import type { ResolvedColumn } from '../lib/viewColumns';

interface Props {
  table: Table;
  row: RecordData;
  fields: ResolvedColumn[];
  cover?: Column;
  maxFields?: number;
  onOpen: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  compact?: boolean;
}

/** Card used by gallery and kanban: optional cover image, title (primary field) and a few fields. */
export function RecordCard({ table, row, fields, cover, maxFields = 5, onOpen, draggable, onDragStart, compact }: Props) {
  const img = cover ? asAttachments(row[cover.id]).find(isImage) : undefined;
  const body = fields.filter((f) => f.show && !f.column.primary && f.column.id !== cover?.id).slice(0, maxFields);
  return (
    <div
      className={`record-card ${compact ? 'compact' : ''}`}
      onClick={onOpen}
      draggable={draggable}
      onDragStart={onDragStart}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      {cover && (
        <div className="card-cover">{img ? <img src={img.url} alt={img.title} loading="lazy" /> : <Icon name="paperclip" size={22} />}</div>
      )}
      <div className="card-body">
        <div className="card-title">{recordTitle(table, row)}</div>
        {body.map((f) => {
          const v = row[f.column.id];
          if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return null;
          return (
            <div key={f.column.id} className="card-field">
              <div className="card-field-label">{f.column.title}</div>
              <div className="card-field-value">
                <CellDisplay column={f.column} value={v} readOnly />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
