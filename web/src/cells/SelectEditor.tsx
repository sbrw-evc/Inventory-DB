import { useMemo, useState } from 'react';
import type { Column } from '@shared';
import { metaApi } from '../api/endpoints';
import { useBaseCache } from '../api/hooks';
import { Icon } from '../components/Icon';
import { t } from '../i18n';
import { useBaseData } from '../lib/baseContext';
import { nextChoiceColor } from '../lib/colors';
import { asStringList } from '../lib/format';
import { toastError } from '../lib/toast';
import { Chip } from './CellDisplay';

interface Props {
  column: Column;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Close after picking (single select). */
  onDone?: () => void;
}

/** Option list with search, toggle and "create option" for Single/MultiSelect. */
export function SelectEditor({ column, value, onChange, onDone }: Props) {
  const multi = column.type === 'MultiSelect';
  const { baseId, perms, isPublic } = useBaseData();
  const cache = useBaseCache();
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const choices = column.options.choices ?? [];
  const selected = multi ? asStringList(value) : value ? [String(value)] : [];
  const filtered = useMemo(
    () => choices.filter((c) => c.title.toLowerCase().includes(search.trim().toLowerCase())),
    [choices, search],
  );
  const exact = choices.some((c) => c.title.toLowerCase() === search.trim().toLowerCase());
  const canCreate = !!search.trim() && !exact && perms.canEdit && !isPublic;

  const pick = (title: string) => {
    if (multi) {
      onChange(selected.includes(title) ? selected.filter((s) => s !== title) : [...selected, title]);
    } else {
      onChange(selected[0] === title ? null : title);
      onDone?.();
    }
  };

  const create = async () => {
    const title = search.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      const updated = await metaApi.updateColumn(column.id, {
        options: { ...column.options, choices: [...choices, { title, color: nextChoiceColor(choices) }] },
      });
      if (baseId) cache.setColumn(baseId, updated);
      setSearch('');
      pick(title);
    } catch (e) {
      toastError(e);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="select-editor">
      {multi && selected.length > 0 && (
        <div className="select-editor-selected">
          {selected.map((s) => (
            <span key={s} className="chip-removable">
              <Chip column={column} title={s} />
              <button type="button" className="chip-x" onClick={() => pick(s)} aria-label={t('Remove')}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className="input input-sm"
        autoFocus
        placeholder={perms.canEdit && !isPublic ? t('Search or create an option') : t('Search options')}
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (filtered[active]) pick(filtered[active].title);
            else if (canCreate) void create();
          }
        }}
      />
      <div className="select-editor-list">
        {filtered.map((c, i) => (
          <button
            type="button"
            key={c.title}
            className={`select-option ${i === active ? 'active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(c.title)}
          >
            <span className="select-option-check">{selected.includes(c.title) && <Icon name="check" size={13} />}</span>
            <Chip column={column} title={c.title} />
          </button>
        ))}
        {!filtered.length && !canCreate && <div className="empty-hint">{t('No options')}</div>}
        {canCreate && (
          <button type="button" className="select-option create" onClick={create} disabled={creating}>
            <Icon name="plus" size={13} /> {t('Create option')} <b>{search.trim()}</b>
          </button>
        )}
      </div>
      {!multi && selected.length > 0 && (
        <button type="button" className="link-btn" onClick={() => { onChange(null); onDone?.(); }}>
          {t('Clear')}
        </button>
      )}
    </div>
  );
}
