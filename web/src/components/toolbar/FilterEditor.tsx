import type { Column, FilterCondition, FilterGroup } from '@shared';
import { isFilterGroup, opsForType } from '@shared';
import { t } from '../../i18n';
import {
  addChild,
  changeConditionColumn,
  changeConditionOp,
  emptyGroup,
  filterableColumns,
  newCondition,
  OP_LABELS,
  opNeedsValue,
  opTakesList,
  removeNode,
  setGroupLogic,
  updateCondition,
  WITHIN_OPTIONS,
} from '../../lib/filters';
import { asStringList } from '../../lib/format';
import { Icon } from '../Icon';

const MAX_DEPTH = 2;

function ValueInput({ cond, column, onChange, disabled }: { cond: FilterCondition; column?: Column; onChange: (v: unknown) => void; disabled?: boolean }) {
  if (!column || !opNeedsValue(cond.op)) return <span className="filter-value-spacer" />;
  if (cond.op === 'isWithin') {
    return (
      <select className="input input-sm" value={String(cond.value ?? 'pastWeek')} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {WITHIN_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {t(o.label)}
          </option>
        ))}
      </select>
    );
  }
  const choices = column.options.choices ?? [];
  if ((column.type === 'SingleSelect' || column.type === 'MultiSelect') && choices.length) {
    if (opTakesList(cond.op)) {
      const selected = asStringList(cond.value);
      return (
        <div className="filter-multi">
          {choices.map((c) => (
            <label key={c.title} className="filter-multi-opt">
              <input
                type="checkbox"
                disabled={disabled}
                checked={selected.includes(c.title)}
                onChange={(e) => onChange(e.target.checked ? [...selected, c.title] : selected.filter((s) => s !== c.title))}
              />
              <span className="chip" style={{ background: c.color }}>
                {c.title}
              </span>
            </label>
          ))}
        </div>
      );
    }
    return (
      <select className="input input-sm" value={String(cond.value ?? '')} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">{t('Select…')}</option>
        {choices.map((c) => (
          <option key={c.title} value={c.title}>
            {c.title}
          </option>
        ))}
      </select>
    );
  }
  const numeric = ['Number', 'Decimal', 'Currency', 'Percent', 'Rating', 'ID', 'Rollup'].includes(column.type);
  const date = ['Date', 'DateTime', 'CreatedTime', 'LastModifiedTime'].includes(column.type);
  return (
    <input
      className="input input-sm"
      type={numeric ? 'number' : date ? 'date' : 'text'}
      value={cond.value === undefined || cond.value === null ? '' : String(cond.value)}
      placeholder={t('Value')}
      disabled={disabled}
      onChange={(e) => onChange(numeric && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
    />
  );
}

interface Props {
  root: FilterGroup;
  columns: Column[];
  onChange: (root: FilterGroup) => void;
  disabled?: boolean;
}

function GroupEditor({ group, root, columns, onChange, depth, disabled }: Props & { group: FilterGroup; depth: number }) {
  const filterable = filterableColumns(columns);
  return (
    <div className={`filter-group depth-${depth}`}>
      {group.children.length === 0 && <div className="empty-hint">{depth === 0 ? t('No filters applied') : t('Empty group')}</div>}
      {group.children.map((child, i) => {
        const logicCell =
          i === 0 ? (
            <span className="filter-logic">{t('Where')}</span>
          ) : i === 1 ? (
            <select
              className="input input-sm filter-logic"
              value={group.logic}
              disabled={disabled}
              onChange={(e) => onChange(setGroupLogic(root, group.id!, e.target.value as 'and' | 'or'))}
            >
              <option value="and">{t('and')}</option>
              <option value="or">{t('or')}</option>
            </select>
          ) : (
            <span className="filter-logic">{t(group.logic)}</span>
          );
        if (isFilterGroup(child)) {
          return (
            <div key={child.id} className="filter-row filter-row-group">
              {logicCell}
              <GroupEditor group={child} root={root} columns={columns} onChange={onChange} depth={depth + 1} disabled={disabled} />
              <button className="icon-btn" disabled={disabled} onClick={() => onChange(removeNode(root, child.id!))} title={t('Remove group')}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          );
        }
        const column = columns.find((c) => c.id === child.columnId);
        const ops = column ? opsForType(column.type) : [];
        return (
          <div key={child.id} className="filter-row">
            {logicCell}
            <select
              className="input input-sm"
              value={child.columnId}
              disabled={disabled}
              onChange={(e) => {
                const col = columns.find((c) => c.id === e.target.value);
                if (col) onChange(updateCondition(root, child.id!, changeConditionColumn(child, col)));
              }}
            >
              {!column && <option value="">{t('Choose field')}</option>}
              {filterable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <select
              className="input input-sm"
              value={child.op}
              disabled={disabled}
              onChange={(e) => onChange(updateCondition(root, child.id!, changeConditionOp(child, e.target.value as FilterCondition['op'])))}
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {t(OP_LABELS[op])}
                </option>
              ))}
            </select>
            <ValueInput cond={child} column={column} disabled={disabled} onChange={(value) => onChange(updateCondition(root, child.id!, { value }))} />
            <button className="icon-btn" disabled={disabled} onClick={() => onChange(removeNode(root, child.id!))} title={t('Remove filter')}>
              <Icon name="x" size={13} />
            </button>
          </div>
        );
      })}
      {!disabled && (
        <div className="filter-actions">
          <button className="link-btn" onClick={() => onChange(addChild(root, group.id!, newCondition(columns)))}>
            <Icon name="plus" size={13} /> {t('Add filter')}
          </button>
          {depth < MAX_DEPTH && (
            <button className="link-btn" onClick={() => onChange(addChild(root, group.id!, { ...emptyGroup(), children: [newCondition(columns)] }))}>
              <Icon name="plus" size={13} /> {t('Add filter group')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Nested AND/OR filter editor with type-aware operators and value inputs. */
export function FilterEditor(props: Props) {
  return (
    <div className="filter-editor">
      <GroupEditor {...props} group={props.root} depth={0} />
    </div>
  );
}
