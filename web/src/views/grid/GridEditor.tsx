import { useEffect, useRef, useState } from 'react';
import type { Column } from '@shared';
import { AttachmentEditor } from '../../cells/AttachmentEditor';
import { SelectEditor } from '../../cells/SelectEditor';
import { Popover } from '../../components/Popover';
import { t } from '../../i18n';
import { fromDateTimeInput, parseInputValue, toDateInput, toDateTimeInput } from '../../lib/format';

/** Where the cursor goes after a commit; 'keep' saves but stays in the editor. */
export type Move = 'down' | 'up' | 'right' | 'left' | 'keep' | null;

/** Types edited inline (an <input> replaces the cell content). */
export const INLINE_TYPES = new Set([
  'SingleLineText',
  'Email',
  'URL',
  'PhoneNumber',
  'Number',
  'Decimal',
  'Currency',
  'Percent',
  'Date',
  'DateTime',
  'GeoData',
]);
/** Types edited in a popover anchored to the cell. */
export const POPOVER_TYPES = new Set(['LongText', 'JSON', 'SingleSelect', 'MultiSelect', 'Attachment']);
/** Types where typing a character starts editing with that character. */
export const TYPE_TO_EDIT = new Set(['SingleLineText', 'Email', 'URL', 'PhoneNumber', 'Number', 'Decimal', 'Currency', 'Percent', 'LongText', 'GeoData']);

interface EditorProps {
  column: Column;
  value: unknown;
  /** Text typed to start editing; replaces the value. */
  initialText?: string;
  onCommit: (value: unknown, move: Move) => void;
  onCancel: () => void;
  anchor: HTMLElement | null;
}

function initialFor(column: Column, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (column.type === 'Date') return toDateInput(value);
  if (column.type === 'DateTime') return toDateTimeInput(value);
  if (column.type === 'JSON') return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return String(value);
}

function InlineInput({ column, value, initialText, onCommit, onCancel }: EditorProps) {
  const [text, setText] = useState(initialText ?? initialFor(column, value));
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (el.type === 'text') el.setSelectionRange(el.value.length, el.value.length);
  }, [initialText]);

  const finish = (move: Move) => {
    if (done.current) return;
    done.current = true;
    let parsed: unknown;
    if (column.type === 'Date') parsed = text || null;
    else if (column.type === 'DateTime') parsed = fromDateTimeInput(text);
    else parsed = parseInputValue(column, text);
    if (parsed === undefined) {
      onCancel();
      return;
    }
    onCommit(parsed, move);
  };

  const type = column.type === 'Date' ? 'date' : column.type === 'DateTime' ? 'datetime-local' : 'text';
  return (
    <input
      ref={ref}
      className={`cell-input ${['Number', 'Decimal', 'Currency', 'Percent'].includes(column.type) ? 'num' : ''}`}
      type={type}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(e.shiftKey ? 'up' : 'down');
        } else if (e.key === 'Tab') {
          e.preventDefault();
          finish(e.shiftKey ? 'left' : 'right');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
    />
  );
}

function TextAreaPopover({ column, value, initialText, onCommit, onCancel, anchor }: EditorProps) {
  const [text, setText] = useState(initialText ?? initialFor(column, value));
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const commit = (move: Move) => {
    if (done.current) return;
    let parsed: unknown = text === '' ? null : text;
    if (column.type === 'JSON' && text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }
    done.current = true;
    onCommit(parsed, move);
  };
  return (
    <Popover
      anchor={anchor ? anchor.getBoundingClientRect() : null}
      onClose={() => commit(null)}
      onEscape={() => {
        done.current = true;
        onCancel();
      }}
      className="popover-pad textarea-popover"
      offset={-(anchor?.offsetHeight ?? 0)}
    >
      <textarea
        autoFocus
        className={`input ${column.type === 'JSON' ? 'mono' : ''}`}
        rows={column.type === 'JSON' ? 10 : 6}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onFocus={(e) => {
          const len = e.target.value.length;
          e.target.setSelectionRange(len, len);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit('down');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            done.current = true;
            onCancel();
          }
        }}
      />
      <div className="popover-footer">
        {error ? <span className="error-text">{t('Invalid JSON')}: {error}</span> : <span className="muted small">{t('Ctrl+Enter to save, Esc to cancel')}</span>}
        <button className="btn btn-primary btn-sm" onClick={() => commit(null)}>
          {t('Save')}
        </button>
      </div>
    </Popover>
  );
}

/** Popover editors that apply each change immediately (selects, attachments). */
function LivePopover({ column, value, onCommit, onCancel, anchor }: EditorProps) {
  const [current, setCurrent] = useState(value);
  return (
    <Popover anchor={anchor ? anchor.getBoundingClientRect() : null} onClose={onCancel} className="popover-pad" >
      {column.type === 'Attachment' ? (
        <div style={{ width: 340 }}>
          <AttachmentEditor
            value={current}
            onChange={(v) => {
              setCurrent(v);
              onCommit(v, 'keep');
            }}
          />
        </div>
      ) : (
        <div style={{ width: 260 }}>
          <SelectEditor
            column={column}
            value={current}
            onChange={(v) => {
              setCurrent(v);
              onCommit(v, 'keep');
            }}
            onDone={onCancel}
          />
        </div>
      )}
    </Popover>
  );
}

export function GridEditor(props: EditorProps) {
  const type = props.column.type;
  if (INLINE_TYPES.has(type)) return <InlineInput {...props} />;
  if (type === 'LongText' || type === 'JSON') return <TextAreaPopover {...props} />;
  if (POPOVER_TYPES.has(type)) return <LivePopover {...props} />;
  return null;
}
