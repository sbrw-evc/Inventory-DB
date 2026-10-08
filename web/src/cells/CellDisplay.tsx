import type { Column } from '@shared';
import { Icon } from '../components/Icon';
import { t } from '../i18n';
import { lookupTarget, useBaseData } from '../lib/baseContext';
import { chipStyle, choiceColor } from '../lib/colors';
import { asArray, asAttachments, asStringList, formatValue, isImage, toNumber } from '../lib/format';

export function Chip({ column, title }: { column: Pick<Column, 'options'>; title: string }) {
  return (
    <span className="chip" style={chipStyle(choiceColor(column, title))} title={title}>
      {title}
    </span>
  );
}

export function Stars({ value, max, onRate, readOnly }: { value: number; max: number; onRate?: (v: number) => void; readOnly?: boolean }) {
  return (
    <span className={`stars ${readOnly ? '' : 'stars-interactive'}`}>
      {Array.from({ length: max }, (_, i) => (
        <button
          key={i}
          type="button"
          tabIndex={-1}
          className={`star ${i < value ? 'on' : ''}`}
          disabled={readOnly}
          onClick={(e) => {
            e.stopPropagation();
            onRate?.(i + 1 === value ? 0 : i + 1);
          }}
          aria-label={`${i + 1}`}
        >
          ★
        </button>
      ))}
    </span>
  );
}

export function CheckboxMark({ checked, onToggle, readOnly }: { checked: boolean; onToggle?: () => void; readOnly?: boolean }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`checkbox-mark ${checked ? 'checked' : ''}`}
      disabled={readOnly}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      aria-pressed={checked}
    >
      {checked && <Icon name="check" size={12} />}
    </button>
  );
}

export const isChecked = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

interface CellDisplayProps {
  column: Column;
  value: unknown;
  /** Toggling checkbox / rating directly in display mode. */
  onQuickChange?: (value: unknown) => void;
  readOnly?: boolean;
  /** Wrap text (tall rows, cards). */
  wrap?: boolean;
}

/** Read-only rendering of a value for any field type. */
export function CellDisplay({ column, value, onQuickChange, readOnly, wrap }: CellDisplayProps) {
  const { tables } = useBaseData();
  switch (column.type) {
    case 'Checkbox':
      return (
        <span className="cell-center">
          <CheckboxMark checked={isChecked(value)} readOnly={readOnly} onToggle={() => onQuickChange?.(!isChecked(value))} />
        </span>
      );
    case 'Rating':
      return <Stars value={toNumber(value) ?? 0} max={column.options.max ?? 5} readOnly={readOnly} onRate={(v) => onQuickChange?.(v)} />;
    case 'SingleSelect':
      return value ? (
        <span className="chips">
          <Chip column={column} title={String(value)} />
        </span>
      ) : null;
    case 'MultiSelect': {
      const list = asStringList(value);
      return list.length ? (
        <span className={`chips ${wrap ? 'chips-wrap' : ''}`}>
          {list.map((v) => (
            <Chip key={v} column={column} title={v} />
          ))}
        </span>
      ) : null;
    }
    case 'Attachment': {
      const list = asAttachments(value);
      return list.length ? (
        <span className="attachments-inline">
          {list.map((a, i) =>
            isImage(a) ? (
              <img key={i} className="thumb" src={a.url} alt={a.title} title={a.title} loading="lazy" />
            ) : (
              <span key={i} className="file-pill" title={a.title}>
                <Icon name="paperclip" size={12} />
                {a.title}
              </span>
            ),
          )}
        </span>
      ) : null;
    }
    case 'Email':
      return value ? (
        <a className="cell-link" href={`mailto:${value}`} onClick={(e) => e.stopPropagation()}>
          {String(value)}
        </a>
      ) : null;
    case 'URL': {
      if (!value) return null;
      const s = String(value);
      const href = /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`;
      return (
        <a className="cell-link" href={href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
          {s}
        </a>
      );
    }
    case 'PhoneNumber':
      return value ? (
        <a className="cell-link" href={`tel:${value}`} onClick={(e) => e.stopPropagation()}>
          {String(value)}
        </a>
      ) : null;
    case 'Links': {
      if (typeof value === 'number' || value === null || value === undefined) {
        const n = typeof value === 'number' ? value : 0;
        return n ? <span className="link-count">{n === 1 ? t('1 record') : t('{n} records', { n })}</span> : null;
      }
      return (
        <span className="chips">
          {asArray(value).map((v, i) => (
            <span key={i} className="chip chip-link">
              {typeof v === 'object' && v ? String((v as { title?: unknown }).title ?? JSON.stringify(v)) : String(v)}
            </span>
          ))}
        </span>
      );
    }
    case 'Lookup': {
      const target = lookupTarget(column, tables);
      const list = asArray(value);
      if (!list.length) return null;
      if (target && (target.type === 'SingleSelect' || target.type === 'MultiSelect')) {
        return (
          <span className="chips">
            {list.flatMap((v) => asStringList(v)).map((v, i) => (
              <Chip key={i} column={target} title={v} />
            ))}
          </span>
        );
      }
      return (
        <span className="chips">
          {list.map((v, i) => (
            <span key={i} className="chip chip-lookup">
              {target ? formatValue(target, v) : formatValue(column, v)}
            </span>
          ))}
        </span>
      );
    }
    case 'Rollup': {
      const target = lookupTarget(column, tables);
      const fn = column.options.rollupFunction;
      const numeric = target && ['Decimal', 'Currency', 'Percent', 'Number'].includes(target.type) && fn !== 'count' && fn !== 'countDistinct';
      return <span className="cell-text cell-num">{numeric ? formatValue(target!, value) : formatValue(column, value)}</span>;
    }
    case 'LongText':
    case 'JSON':
      return <span className={`cell-text ${wrap ? 'wrap' : ''} ${column.type === 'JSON' ? 'mono' : ''}`}>{formatValue(column, value)}</span>;
    case 'Number':
    case 'Decimal':
    case 'Currency':
    case 'Percent':
    case 'ID':
      return <span className="cell-text cell-num">{formatValue(column, value)}</span>;
    case 'Formula':
      return <span className={`cell-text ${typeof value === 'number' ? 'cell-num' : ''}`}>{formatValue(column, value)}</span>;
    default:
      return <span className={`cell-text ${wrap ? 'wrap' : ''}`}>{formatValue(column, value)}</span>;
  }
}
