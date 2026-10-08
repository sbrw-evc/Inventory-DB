import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { Column, Table } from '@shared';
import { isReadOnlyType } from '@shared';
import { dataApi } from '../api/endpoints';
import { qk } from '../api/hooks';
import { Icon } from '../components/Icon';
import { Popover } from '../components/Popover';
import { t } from '../i18n';
import { findTable, recordTitle, useBaseData } from '../lib/baseContext';
import { fromDateTimeInput, parseInputValue, toDateInput, toDateTimeInput } from '../lib/format';
import { AttachmentEditor } from './AttachmentEditor';
import { CellDisplay, CheckboxMark, isChecked, Stars } from './CellDisplay';
import { LinkPicker } from './LinkPicker';
import { SelectEditor } from './SelectEditor';

export interface FieldInputProps {
  column: Column;
  value: unknown;
  onChange: (value: unknown) => void;
  readOnly?: boolean;
  table?: Table;
  /** Existing record id (needed for Links). */
  recordId?: number;
  autoFocus?: boolean;
  placeholder?: string;
}

/** Text value shown in a text input for a stored value. */
function textFor(column: Column, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (column.type === 'JSON') return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return String(value);
}

function TextField({ column, value, onChange, readOnly, autoFocus, placeholder }: FieldInputProps) {
  const [text, setText] = useState(textFor(column, value));
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(textFor(column, value));
  }, [value, column]);
  const multiline = column.type === 'LongText' || column.type === 'JSON';
  const commit = () => {
    const parsed = parseInputValue(column, text);
    if (parsed === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const before = value === undefined ? null : value;
    if (JSON.stringify(parsed) !== JSON.stringify(before)) onChange(parsed);
  };
  const common = {
    className: `input ${invalid ? 'input-invalid' : ''} ${column.type === 'JSON' ? 'mono' : ''}`,
    value: text,
    disabled: readOnly,
    autoFocus,
    placeholder,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      commit();
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
  };
  if (multiline) return <textarea {...common} rows={column.type === 'JSON' ? 6 : 4} />;
  const inputType =
    column.type === 'Email' ? 'email' : column.type === 'URL' ? 'url' : column.type === 'PhoneNumber' ? 'tel' : 'text';
  const numeric = ['Number', 'Decimal', 'Currency', 'Percent'].includes(column.type);
  return (
    <div className={`input-affix ${numeric ? 'numeric' : ''}`}>
      {column.type === 'Currency' && <span className="affix">{column.options.currencyCode || 'USD'}</span>}
      <input
        {...common}
        type={inputType}
        inputMode={numeric ? 'decimal' : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {column.type === 'Percent' && <span className="affix">%</span>}
    </div>
  );
}

function SelectField({ column, value, onChange, readOnly }: FieldInputProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        type="button"
        ref={ref}
        className="input select-trigger"
        disabled={readOnly}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="select-trigger-value">
          {value && (!Array.isArray(value) || value.length) ? (
            <CellDisplay column={column} value={value} readOnly wrap />
          ) : (
            <span className="muted">{t('Select…')}</span>
          )}
        </span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <Popover anchor={ref} onClose={() => setOpen(false)} matchWidth className="popover-pad">
          <SelectEditor column={column} value={value} onChange={onChange} onDone={() => setOpen(false)} />
        </Popover>
      )}
    </>
  );
}

function LinksField({ column, table, recordId, readOnly }: FieldInputProps) {
  const { tables } = useBaseData();
  const [open, setOpen] = useState(false);
  const related = findTable(tables, column.options.relatedTableId);
  const linked = useQuery({
    queryKey: [...qk.links(table?.id ?? '', recordId ?? 0, column.id), ''],
    queryFn: () => dataApi.listLinks(table!.id, recordId!, column.id, { limit: 100 }),
    enabled: !!table && !!recordId,
  });
  if (!recordId || !table) return <div className="muted small">{t('Save the record first to link records.')}</div>;
  const list = linked.data?.list ?? [];
  return (
    <div className="links-field">
      <div className="chips chips-wrap">
        {list.map((r) => (
          <span key={r.id} className="chip chip-link">
            {recordTitle(related, r)}
          </span>
        ))}
        {!list.length && !linked.isLoading && <span className="muted small">{t('No linked records')}</span>}
      </div>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        <Icon name="link" size={13} /> {readOnly ? t('View links') : t('Manage links')}
      </button>
      {open && <LinkPicker table={table} column={column} recordId={recordId} readOnly={readOnly} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Always-visible editor for a field (expanded record, forms). */
export function FieldInput(props: FieldInputProps) {
  const { column, value, onChange, readOnly } = props;
  if (column.type === 'Links') return <LinksField {...props} />;
  if (isReadOnlyType(column.type)) {
    return (
      <div className="readonly-value">
        <CellDisplay column={column} value={value} readOnly wrap />
      </div>
    );
  }
  switch (column.type) {
    case 'Checkbox':
      return <CheckboxMark checked={isChecked(value)} readOnly={readOnly} onToggle={() => onChange(!isChecked(value))} />;
    case 'Rating':
      return <Stars value={Number(value) || 0} max={column.options.max ?? 5} readOnly={readOnly} onRate={onChange} />;
    case 'SingleSelect':
    case 'MultiSelect':
      return <SelectField {...props} />;
    case 'Attachment':
      return <AttachmentEditor value={value} onChange={onChange} readOnly={readOnly} />;
    case 'Date':
      return (
        <input
          type="date"
          className="input"
          disabled={readOnly}
          value={toDateInput(value)}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'DateTime':
      return (
        <input
          type="datetime-local"
          className="input"
          disabled={readOnly}
          value={toDateTimeInput(value)}
          onChange={(e) => onChange(fromDateTimeInput(e.target.value))}
        />
      );
    default:
      return <TextField {...props} />;
  }
}
