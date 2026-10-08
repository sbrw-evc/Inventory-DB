import { useState } from 'react';
import type { Column, FilterGroup, Sort, Table, View } from '@shared';
import { isFilterGroup } from '@shared';
import { platformApi, type ViewPatch } from '../../api/endpoints';
import { t } from '../../i18n';
import { countConditions, OP_LABELS } from '../../lib/filters';
import { formatValue } from '../../lib/format';
import type { Permissions } from '../../lib/roles';
import { toastError } from '../../lib/toast';
import { type ResolvedColumn, toViewColumns } from '../../lib/viewColumns';
import { Icon, VIEW_LABELS, ViewIcon } from '../Icon';
import { Dropdown, MenuItem } from '../Popover';
import { copyText, ShareDialog } from '../ShareDialog';
import { WebhooksDialog } from '../WebhooksDialog';
import { ColumnPicker, FieldsMenu, FilterMenu, RowHeightMenu, SortMenu } from './menus';

export interface ToolbarProps {
  baseId: string;
  table: Table;
  view: View;
  resolved: ResolvedColumn[];
  perms: Permissions;
  /** Changes are saved to the view (editor, view not locked). */
  canPersist: boolean;
  update: (patch: ViewPatch, opts?: { immediate?: boolean }) => void;
  saving: boolean;
  /** Effective filter/sorts shown in the menus (view's when persisted, URL's otherwise). */
  filter: FilterGroup | null;
  sorts: Sort[];
  onFilter: (f: FilterGroup | null) => void;
  onSorts: (s: Sort[]) => void;
  search: string;
  onSearch: (s: string) => void;
  total: number | null;
  onNewRecord: () => void;
}

function conditionText(columns: Column[], c: { columnId: string; op: keyof typeof OP_LABELS; value?: unknown }) {
  const col = columns.find((x) => x.id === c.columnId);
  const val = Array.isArray(c.value) ? c.value.join(', ') : c.value === undefined || c.value === null ? '' : col && typeof c.value !== 'object' && ['Date', 'DateTime'].includes(col.type) ? formatValue(col, c.value) : String(c.value);
  return { field: col?.title ?? '?', rest: `${t(OP_LABELS[c.op])} ${val}`.trim() };
}

export function ViewToolbar(p: ToolbarProps) {
  const { table, view, resolved, perms, canPersist, update } = p;
  const [share, setShare] = useState(false);
  const [hooks, setHooks] = useState(false);
  const columns = table.columns;
  const type = view.type;
  const localOnly = !canPersist;
  const nFilters = countConditions(p.filter);
  const hiddenCount = resolved.filter((r) => !r.show).length;
  const groupBy = view.meta.groupBy ?? [];

  const exportAs = async (format: 'csv' | 'xlsx') => {
    try {
      await platformApi.exportView(view.id, format, `${table.title} - ${view.title}`);
    } catch (e) {
      toastError(e);
    }
  };

  const topLevelConds = (p.filter?.children ?? []).filter((c) => !isFilterGroup(c));
  const nestedGroups = (p.filter?.children ?? []).filter(isFilterGroup).length;

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-view-name" title={VIEW_LABELS[type]}>
          <ViewIcon type={type} />
          <span>{view.title}</span>
          {view.locked && <Icon name="lock" size={13} className="muted" title={t('Locked view')} />}
        </div>
        <span className="toolbar-sep" />
        {type !== 'form' && type !== 'calendar' && (
          <Dropdown
            label={<><Icon name="eyeOff" size={14} /> {t('Fields')}{hiddenCount ? ` · ${hiddenCount} ${t('hidden')}` : ''}</>}
            active={hiddenCount > 0}
            className="popover-pad menu-wide"
          >
            {() => (
              <FieldsMenu resolved={resolved} disabled={!canPersist && !perms.canEdit} onChange={(next) => update({ columns: toViewColumns(next) })} />
            )}
          </Dropdown>
        )}
        {type !== 'form' && (
          <>
            <Dropdown
              label={<><Icon name="filter" size={14} /> {t('Filter')}{nFilters ? ` · ${nFilters}` : ''}</>}
              active={nFilters > 0}
              className="popover-pad menu-xwide"
            >
              {() => (
                <FilterMenu
                  value={p.filter}
                  columns={columns}
                  onChange={p.onFilter}
                  note={localOnly ? (view.locked ? t('This view is locked. Filters here are temporary and kept in the link.') : t('Filters here are temporary and kept in the link.')) : undefined}
                />
              )}
            </Dropdown>
            {type !== 'calendar' && (
              <Dropdown
                label={<><Icon name="sort" size={14} /> {t('Sort')}{p.sorts.length ? ` · ${p.sorts.length}` : ''}</>}
                active={p.sorts.length > 0}
                className="popover-pad menu-wide"
              >
                {() => <SortMenu sorts={p.sorts} columns={columns} onChange={p.onSorts} />}
              </Dropdown>
            )}
          </>
        )}
        {type === 'grid' && (
          <>
            <Dropdown
              label={<><Icon name="group" size={14} /> {t('Group')}{groupBy.length ? ` · ${groupBy.length}` : ''}</>}
              active={groupBy.length > 0}
              className="popover-pad menu-wide"
              disabled={!canPersist && !groupBy.length}
            >
              {() => (
                <SortMenu
                  title={t('Group by (up to 3 fields)')}
                  sorts={groupBy}
                  max={3}
                  disabled={!canPersist}
                  columns={columns.filter((c) => !['Attachment', 'JSON', 'Links', 'LongText'].includes(c.type))}
                  onChange={(g) => update({ meta: { groupBy: g } })}
                />
              )}
            </Dropdown>
            <Dropdown label={<><Icon name="rowHeight" size={14} /> <span className="hide-mid">{t('Row height')}</span></>} title={t('Row height')} className="menu">
              {(close) => (
                <RowHeightMenu
                  value={view.meta.rowHeight}
                  onChange={(v) => {
                    update({ meta: { rowHeight: v } });
                    close();
                  }}
                />
              )}
            </Dropdown>
          </>
        )}
        {type === 'kanban' && (
          <Dropdown label={<><Icon name="kanban" size={14} /> {t('Stack by')}</>} className="menu" disabled={!canPersist}>
            {(close) => (
              <ColumnPicker
                label={t('Stack by')}
                columns={columns.filter((c) => c.type === 'SingleSelect')}
                value={view.meta.groupColumnId}
                onChange={(id) => {
                  update({ meta: { groupColumnId: id } });
                  close();
                }}
              />
            )}
          </Dropdown>
        )}
        {(type === 'kanban' || type === 'gallery') && (
          <Dropdown label={<><Icon name="paperclip" size={14} /> {t('Cover')}</>} className="menu" disabled={!canPersist}>
            {(close) => (
              <ColumnPicker
                label={t('Cover image field')}
                allowNone
                columns={columns.filter((c) => c.type === 'Attachment')}
                value={view.meta.coverColumnId}
                onChange={(id) => {
                  update({ meta: { coverColumnId: id ?? '' } });
                  close();
                }}
              />
            )}
          </Dropdown>
        )}
        {type === 'calendar' && (
          <Dropdown label={<><Icon name="calendar" size={14} /> {t('Date field')}</>} className="menu" disabled={!canPersist}>
            {(close) => (
              <ColumnPicker
                label={t('Place records by')}
                columns={columns.filter((c) => ['Date', 'DateTime', 'CreatedTime', 'LastModifiedTime'].includes(c.type))}
                value={view.meta.dateColumnId}
                onChange={(id) => {
                  update({ meta: { dateColumnId: id } });
                  close();
                }}
              />
            )}
          </Dropdown>
        )}
        {type !== 'form' && (
          <div className="toolbar-search">
            <Icon name="search" size={14} />
            <input placeholder={t('Search in view')} value={p.search} onChange={(e) => p.onSearch(e.target.value)} />
            {p.search && (
              <button className="icon-btn" onClick={() => p.onSearch('')} aria-label={t('Clear search')}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        )}
        <span className="spacer" />
        {type !== 'form' && (
          <button className="tb-btn" onClick={() => copyText(window.location.href)} title={t('Copy link with filters')}>
            <Icon name="link" size={14} /> <span className="hide-narrow">{t('Copy link with filters')}</span>
          </button>
        )}
        {type !== 'form' && (
          <Dropdown label={<><Icon name="download" size={14} /> <span className="hide-narrow">{t('Export')}</span></>} align="end" className="menu">
            {(close) => (
              <>
                <MenuItem icon={<Icon name="download" />} onClick={() => { close(); void exportAs('csv'); }}>
                  {t('Download CSV')}
                </MenuItem>
                <MenuItem icon={<Icon name="download" />} onClick={() => { close(); void exportAs('xlsx'); }}>
                  {t('Download Excel (.xlsx)')}
                </MenuItem>
              </>
            )}
          </Dropdown>
        )}
        {perms.canEdit && (
          <Dropdown label={<Icon name="more" size={16} />} buttonClassName="tb-btn tb-icon" align="end" className="menu" title={t('More')}>
            {(close) => (
              <>
                <MenuItem icon={<Icon name="share" />} onClick={() => { close(); setShare(true); }}>
                  {t('Share view')}
                </MenuItem>
                {(!view.locked || perms.isOwner) && (
                  <MenuItem icon={<Icon name={view.locked ? 'unlock' : 'lock'} />} onClick={() => { close(); update({ locked: !view.locked }, { immediate: true }); }}>
                    {view.locked ? t('Unlock view') : t('Lock view')}
                  </MenuItem>
                )}
                <MenuItem icon={<Icon name="webhook" />} onClick={() => { close(); setHooks(true); }}>
                  {t('Webhooks')}
                </MenuItem>
              </>
            )}
          </Dropdown>
        )}
        {perms.canEdit && type !== 'form' && (
          <button className="btn btn-primary btn-sm" onClick={p.onNewRecord}>
            <Icon name="plus" size={14} /> {t('New record')}
          </button>
        )}
        <span className={`live-indicator ${p.saving ? 'saving' : ''}`} title={canPersist ? t('View changes are saved automatically') : t('Changes are not saved to this view')}>
          <span className="live-dot" />
          {p.saving ? t('Saving…') : canPersist ? t('Saved') : t('Read-only view')}
        </span>
      </div>
      {type !== 'form' && (nFilters > 0 || p.sorts.length > 0 || p.search || p.total !== null) && (
        <div className="filter-row">
          {topLevelConds.map((c, i) => {
            const txt = conditionText(columns, c as never);
            return (
              <span key={i} className="filter-pill">
                <b>{txt.field}:</b> {txt.rest}
              </span>
            );
          })}
          {nestedGroups > 0 && <span className="filter-pill">{t('+{n} filter groups', { n: nestedGroups })}</span>}
          {p.sorts.map((s) => (
            <span key={s.columnId} className="filter-pill sort-pill">
              <Icon name={s.direction === 'asc' ? 'arrowUp' : 'arrowDown'} size={11} />
              {columns.find((c) => c.id === s.columnId)?.title}
            </span>
          ))}
          {p.search && (
            <span className="filter-pill">
              <b>{t('Search')}:</b> {p.search}
            </span>
          )}
          {nFilters > 0 && (
            <button className="link-btn small" onClick={() => p.onFilter(null)} disabled={localOnly && !perms.canView}>
              {t('Clear filters')}
            </button>
          )}
          <span className="spacer" />
          {p.total !== null && <span className="muted small">{p.total === 1 ? t('1 record') : t('{n} records', { n: p.total })}</span>}
        </div>
      )}
      {share && <ShareDialog baseId={p.baseId} view={view} onClose={() => setShare(false)} />}
      {hooks && <WebhooksDialog table={table} onClose={() => setHooks(false)} />}
    </>
  );
}
