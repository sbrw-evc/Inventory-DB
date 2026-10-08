import { useRef, useState } from 'react';
import type { Column, ColumnOptions, FieldType, SelectOption, Table } from '@shared';
import { FIELD_TYPES, ROLLUP_FUNCTIONS } from '@shared';
import { type ColumnInput, metaApi } from '../api/endpoints';
import { t } from '../i18n';
import { useBaseData } from '../lib/baseContext';
import { CHIP_PALETTE, chipStyle, nextChoiceColor } from '../lib/colors';
import { FIELD_LABELS, FieldIcon, Icon } from './Icon';
import { Modal } from './Modal';
import { Popover } from './Popover';

const CREATABLE: FieldType[] = FIELD_TYPES.filter((f) => f !== 'ID');
const CURRENCIES = ['USD', 'EUR', 'GBP', 'RUB', 'JPY', 'CNY', 'INR', 'CAD', 'AUD', 'CHF', 'SEK', 'BRL', 'KZT', 'UAH', 'TRY'];
const FORMULA_FUNCS = [
  'IF(cond, a, b)', 'AND(a, b)', 'OR(a, b)', 'NOT(a)', 'ROUND(x, n)', 'ABS(x)', 'MIN(a, b)', 'MAX(a, b)',
  'CONCAT(a, b)', 'UPPER(s)', 'LOWER(s)', 'LEN(s)', 'TRIM(s)', 'SUBSTR(s, start, len)',
  'NOW()', 'TODAY()', 'DATEADD(date, n, "day")', 'DATETIME_DIFF(a, b, "day")',
];

interface Props {
  table: Table;
  column?: Column;
  onClose: () => void;
  onSaved?: (column: Column) => void;
}

function ColorSwatch({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" ref={ref} className="swatch" style={chipStyle(color)} onClick={() => setOpen(true)} aria-label={t('Colour')} />
      {open && (
        <Popover anchor={ref} onClose={() => setOpen(false)} className="popover-pad">
          <div className="swatch-grid">
            {CHIP_PALETTE.map((p) => (
              <button
                key={p.bg}
                type="button"
                className={`swatch ${p.bg === color ? 'selected' : ''}`}
                style={chipStyle(p.bg)}
                title={t(p.name)}
                onClick={() => {
                  onChange(p.bg);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

function ChoicesEditor({ choices, onChange }: { choices: SelectOption[]; onChange: (c: SelectOption[]) => void }) {
  const set = (i: number, patch: Partial<SelectOption>) => onChange(choices.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= choices.length) return;
    const next = [...choices];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="choices-editor">
      {choices.map((c, i) => (
        <div key={i} className="choice-row">
          <ColorSwatch color={c.color} onChange={(color) => set(i, { color })} />
          <input className="input input-sm" value={c.title} onChange={(e) => set(i, { title: e.target.value })} placeholder={t('Option name')} />
          <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} title={t('Move up')}>
            <Icon name="arrowUp" size={13} />
          </button>
          <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === choices.length - 1} title={t('Move down')}>
            <Icon name="arrowDown" size={13} />
          </button>
          <button type="button" className="icon-btn" onClick={() => onChange(choices.filter((_, j) => j !== i))} title={t('Remove')}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      <button type="button" className="link-btn" onClick={() => onChange([...choices, { title: '', color: nextChoiceColor(choices) }])}>
        <Icon name="plus" size={13} /> {t('Add option')}
      </button>
    </div>
  );
}

/** Create or edit a field, with options for every supported type. */
export function FieldEditor({ table, column, onClose, onSaved }: Props) {
  const { tables } = useBaseData();
  const [title, setTitle] = useState(column?.title ?? '');
  const [type, setType] = useState<FieldType>(column?.type ?? 'SingleLineText');
  const [options, setOptions] = useState<ColumnOptions>(column?.options ?? {});
  const [description, setDescription] = useState(column?.description ?? '');
  const [required, setRequired] = useState(column?.required ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formulaRef = useRef<HTMLTextAreaElement>(null);

  const opt = <K extends keyof ColumnOptions>(k: K, v: ColumnOptions[K]) => setOptions((o) => ({ ...o, [k]: v }));
  const linkColumns = table.columns.filter((c) => c.type === 'Links');
  const linkCol = linkColumns.find((c) => c.id === options.linkColumnId);
  const relatedForLookup = tables.find((tb) => tb.id === linkCol?.options.relatedTableId);
  const isEdit = !!column;
  const typeLocked = isEdit && (column.type === 'Links' || column.type === 'ID');

  const insertFormula = (text: string) => {
    const el = formulaRef.current;
    const cur = options.formula ?? '';
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + text + cur.slice(end);
    opt('formula', next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const validate = (): string | null => {
    if (!title.trim()) return t('Field name is required');
    if (table.columns.some((c) => c.id !== column?.id && c.title.toLowerCase() === title.trim().toLowerCase()))
      return t('A field with this name already exists');
    if (type === 'Links' && !options.relatedTableId) return t('Choose the table to link to');
    if ((type === 'Lookup' || type === 'Rollup') && (!options.linkColumnId || !options.targetColumnId))
      return t('Choose a links field and a target field');
    if (type === 'Rollup' && !options.rollupFunction) return t('Choose a rollup function');
    if (type === 'Formula' && !options.formula?.trim()) return t('Enter a formula');
    if ((type === 'SingleSelect' || type === 'MultiSelect') && (options.choices ?? []).some((c) => !c.title.trim()))
      return t('Options can’t be empty');
    return null;
  };

  const cleanOptions = (): ColumnOptions => {
    const o: ColumnOptions = {};
    const keep = (k: keyof ColumnOptions) => {
      if (options[k] !== undefined) (o as Record<string, unknown>)[k] = options[k];
    };
    switch (type) {
      case 'SingleSelect':
      case 'MultiSelect':
        // Keep server-assigned ids so renamed choices also rename stored values.
        o.choices = (options.choices ?? []).map((c) => {
          const id = (c as SelectOption & { id?: string }).id;
          return { ...(id ? { id } : {}), title: c.title.trim(), color: c.color };
        });
        break;
      case 'Decimal':
      case 'Percent':
        keep('precision');
        break;
      case 'Currency':
        keep('precision');
        o.currencyCode = options.currencyCode || 'USD';
        break;
      case 'Rating':
        o.max = options.max ?? 5;
        break;
      case 'Links':
        o.relatedTableId = options.relatedTableId;
        o.relation = options.relation ?? 'mm';
        keep('symmetricColumnId');
        break;
      case 'Lookup':
        o.linkColumnId = options.linkColumnId;
        o.targetColumnId = options.targetColumnId;
        break;
      case 'Rollup':
        o.linkColumnId = options.linkColumnId;
        o.targetColumnId = options.targetColumnId;
        o.rollupFunction = options.rollupFunction;
        break;
      case 'Formula':
        o.formula = options.formula;
        break;
      default:
        break;
    }
    return o;
  };

  const save = async () => {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setSaving(true);
    setError(null);
    const body: ColumnInput = { title: title.trim(), type, options: cleanOptions(), description: description || null, required };
    try {
      const saved = isEdit ? await metaApi.updateColumn(column.id, body) : await metaApi.createColumn(table.id, body);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isEdit ? t('Edit field') : t('Add field')}
      onClose={onClose}
      width={540}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? t('Saving…') : isEdit ? t('Save field') : t('Add field')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field-label">{t('Field name')}</label>
        <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />

        <label className="field-label">{t('Field type')}</label>
        <div className="type-picker">
          {CREATABLE.map((ft) => (
            <button
              type="button"
              key={ft}
              disabled={typeLocked && ft !== type}
              className={`type-option ${ft === type ? 'selected' : ''}`}
              onClick={() => setType(ft)}
            >
              <FieldIcon type={ft} /> {t(FIELD_LABELS[ft])}
            </button>
          ))}
        </div>
        {isEdit && column.type !== type && (
          <div className="notice notice-warning">{t('Changing the type converts existing values where possible; some data may be lost.')}</div>
        )}

        {(type === 'SingleSelect' || type === 'MultiSelect') && (
          <>
            <label className="field-label">{t('Options')}</label>
            <ChoicesEditor choices={options.choices ?? []} onChange={(c) => opt('choices', c)} />
          </>
        )}

        {(type === 'Decimal' || type === 'Currency' || type === 'Percent') && (
          <>
            <label className="field-label">{t('Precision')}</label>
            <select className="input" value={options.precision ?? (type === 'Percent' ? 0 : 2)} onChange={(e) => opt('precision', Number(e.target.value))}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((p) => (
                <option key={p} value={p}>
                  {p === 0 ? '1' : `1.${'0'.repeat(p)}`}
                </option>
              ))}
            </select>
          </>
        )}
        {type === 'Currency' && (
          <>
            <label className="field-label">{t('Currency')}</label>
            <select className="input" value={options.currencyCode ?? 'USD'} onChange={(e) => opt('currencyCode', e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </>
        )}
        {type === 'Rating' && (
          <>
            <label className="field-label">{t('Maximum')}</label>
            <select className="input" value={options.max ?? 5} onChange={(e) => opt('max', Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </>
        )}
        {type === 'Links' && (
          <>
            <label className="field-label">{t('Link to table')}</label>
            <select
              className="input"
              value={options.relatedTableId ?? ''}
              disabled={isEdit}
              onChange={(e) => opt('relatedTableId', e.target.value || undefined)}
            >
              <option value="">{t('Choose a table…')}</option>
              {tables.map((tb) => (
                <option key={tb.id} value={tb.id}>
                  {tb.title}
                </option>
              ))}
            </select>
            <label className="field-label">{t('Relation')}</label>
            <select className="input" value={options.relation ?? 'mm'} disabled={isEdit} onChange={(e) => opt('relation', e.target.value as 'mm' | 'hm')}>
              <option value="mm">{t('Many to many')}</option>
              <option value="hm">{t('Has many')}</option>
            </select>
          </>
        )}
        {(type === 'Lookup' || type === 'Rollup') && (
          <>
            <label className="field-label">{t('Links field')}</label>
            {linkColumns.length ? (
              <select
                className="input"
                value={options.linkColumnId ?? ''}
                onChange={(e) => setOptions((o) => ({ ...o, linkColumnId: e.target.value || undefined, targetColumnId: undefined }))}
              >
                <option value="">{t('Choose a links field…')}</option>
                {linkColumns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            ) : (
              <div className="notice">{t('This table has no Links fields yet. Add a Links field first.')}</div>
            )}
            {relatedForLookup && (
              <>
                <label className="field-label">
                  {t('Field in')} {relatedForLookup.title}
                </label>
                <select className="input" value={options.targetColumnId ?? ''} onChange={(e) => opt('targetColumnId', e.target.value || undefined)}>
                  <option value="">{t('Choose a field…')}</option>
                  {relatedForLookup.columns
                    .filter((c) => c.type !== 'Links')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title} ({t(FIELD_LABELS[c.type])})
                      </option>
                    ))}
                </select>
              </>
            )}
            {type === 'Rollup' && (
              <>
                <label className="field-label">{t('Function')}</label>
                <select className="input" value={options.rollupFunction ?? ''} onChange={(e) => opt('rollupFunction', (e.target.value || undefined) as ColumnOptions['rollupFunction'])}>
                  <option value="">{t('Choose…')}</option>
                  {ROLLUP_FUNCTIONS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </>
            )}
          </>
        )}
        {type === 'Formula' && (
          <>
            <label className="field-label">{t('Formula')}</label>
            <textarea
              ref={formulaRef}
              className="input mono"
              rows={4}
              placeholder="{Price} * {Quantity}"
              value={options.formula ?? ''}
              onChange={(e) => opt('formula', e.target.value)}
            />
            <div className="formula-help">
              <div>
                <div className="muted small">{t('Fields')}</div>
                <div className="formula-chips">
                  {table.columns
                    .filter((c) => c.id !== column?.id)
                    .map((c) => (
                      <button type="button" key={c.id} className="formula-chip" onClick={() => insertFormula(`{${c.title}}`)}>
                        <FieldIcon type={c.type} size={12} /> {c.title}
                      </button>
                    ))}
                </div>
              </div>
              <div>
                <div className="muted small">{t('Functions')}</div>
                <div className="formula-chips">
                  {FORMULA_FUNCS.map((f) => (
                    <button type="button" key={f} className="formula-chip mono" onClick={() => insertFormula(f.replace(/\(.*\)/, '()'))}>
                      {f}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        <label className="field-label">{t('Description')}</label>
        <input className="input" value={description ?? ''} onChange={(e) => setDescription(e.target.value)} placeholder={t('Optional')} />

        {!['Links', 'Lookup', 'Rollup', 'Formula', 'CreatedTime', 'LastModifiedTime'].includes(type) && (
          <label className="checkbox-label">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> {t('Required')}
          </label>
        )}
      </div>
      {error && <div className="notice notice-error">{error}</div>}
    </Modal>
  );
}
