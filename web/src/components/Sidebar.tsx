import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useRouteIds } from '../lib/useRouteIds';
import type { Base, Table, View, ViewType } from '@shared';
import { metaApi } from '../api/endpoints';
import { qk, useBase, useBases } from '../api/hooks';
import { t } from '../i18n';
import { BASE_COLORS } from '../lib/colors';
import { permissionsFor } from '../lib/roles';
import { toast, toastError } from '../lib/toast';
import { confirmDialog, promptDialog } from './dialogs';
import { Icon, VIEW_LABELS, ViewIcon } from './Icon';
import { ImportDialog } from './ImportDialog';
import { MigrateDialog } from './MigrateDialog';
import { Dropdown, MenuDivider, MenuItem } from './Popover';

const EXPANDED_KEY = 'inventorydb.sidebar.expanded';
const VIEW_TYPES: ViewType[] = ['grid', 'form', 'gallery', 'kanban', 'calendar'];

function loadExpanded(): string[] {
  try {
    return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function useSidebarActions() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return {
    async createBase() {
      const title = await promptDialog({ title: t('New base'), label: t('Base name'), placeholder: t('e.g. Warehouse'), confirmLabel: t('Create') });
      if (!title) return;
      try {
        const color = BASE_COLORS[Math.floor(Math.random() * BASE_COLORS.length)];
        const base = await metaApi.createBase({ title, color });
        await qc.invalidateQueries({ queryKey: qk.bases });
        navigate(`/base/${base.id}`);
      } catch (e) {
        toastError(e);
      }
    },
    async createFromTemplate() {
      try {
        toast(t('Creating the Inventory base…'));
        const base = await metaApi.createInventoryTemplate();
        await qc.invalidateQueries({ queryKey: qk.bases });
        navigate(`/base/${base.id}`);
        toast(t('Inventory base created'), 'success');
      } catch (e) {
        toastError(e);
      }
    },
  };
}

function ViewItem({ base, table, view, canEdit, count }: { base: Base; table: Table; view: View; canEdit: boolean; count: number }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const params = useRouteIds();
  const rename = async () => {
    const title = await promptDialog({ title: t('Rename view'), initial: view.title });
    if (!title) return;
    try {
      await metaApi.updateView(view.id, { title });
      await qc.invalidateQueries({ queryKey: qk.base(base.id) });
    } catch (e) {
      toastError(e);
    }
  };
  const duplicate = async () => {
    try {
      const v = await metaApi.createView(table.id, { title: `${view.title} ${t('copy')}`, type: view.type, copyFromViewId: view.id });
      await qc.invalidateQueries({ queryKey: qk.base(base.id) });
      navigate(`/base/${base.id}/table/${table.id}/view/${v.id}`);
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: t('Delete view “{name}”?', { name: view.title }), message: t('Records are not affected.'), confirmLabel: t('Delete'), danger: true }))) return;
    try {
      await metaApi.deleteView(view.id);
      await qc.invalidateQueries({ queryKey: qk.base(base.id) });
      if (params.viewId === view.id) navigate(`/base/${base.id}/table/${table.id}`);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="sb-item-row">
      <NavLink to={`/base/${base.id}/table/${table.id}/view/${view.id}`} className={({ isActive }) => `sb-item sb-view ${isActive ? 'active' : ''}`}>
        <ViewIcon type={view.type} size={14} />
        <span className="sb-label">{view.title}</span>
        {view.locked && <Icon name="lock" size={11} className="muted" />}
      </NavLink>
      {canEdit && (
        <Dropdown label={<Icon name="more" size={14} />} buttonClassName="sb-more" className="menu">
          {(close) => (
            <>
              <MenuItem icon={<Icon name="edit" />} onClick={() => { close(); void rename(); }}>
                {t('Rename')}
              </MenuItem>
              <MenuItem icon={<Icon name="copy" />} onClick={() => { close(); void duplicate(); }}>
                {t('Duplicate')}
              </MenuItem>
              <MenuItem icon={<Icon name="trash" />} danger disabled={count <= 1} onClick={() => { close(); void remove(); }}>
                {t('Delete')}
              </MenuItem>
            </>
          )}
        </Dropdown>
      )}
    </div>
  );
}

function TableItem({ base, table, canEdit, open, onToggle }: { base: Base; table: Table; canEdit: boolean; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const params = useRouteIds();
  const [importing, setImporting] = useState(false);
  const views = [...(table.views ?? [])].sort((a, b) => a.order - b.order);
  const isCurrent = params.tableId === table.id;

  const addView = async (type: ViewType) => {
    const title = await promptDialog({ title: t('New {type} view', { type: t(VIEW_LABELS[type]) }), initial: t(VIEW_LABELS[type]), confirmLabel: t('Create') });
    if (!title) return;
    try {
      const v = await metaApi.createView(table.id, { title, type });
      await qc.invalidateQueries({ queryKey: qk.base(base.id) });
      navigate(`/base/${base.id}/table/${table.id}/view/${v.id}`);
    } catch (e) {
      toastError(e);
    }
  };
  const rename = async () => {
    const title = await promptDialog({ title: t('Rename table'), initial: table.title });
    if (!title) return;
    try {
      await metaApi.updateTable(table.id, { title });
      await qc.invalidateQueries({ queryKey: qk.base(base.id) });
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: t('Delete table “{name}”?', { name: table.title }), message: t('All records, views and links of this table will be deleted.'), confirmLabel: t('Delete'), danger: true }))) return;
    try {
      await metaApi.deleteTable(table.id);
      await qc.invalidateQueries({ queryKey: qk.base(base.id) });
      if (isCurrent) navigate(`/base/${base.id}`);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="sb-table">
      <div className="sb-item-row">
        <button className={`sb-item sb-table-item ${isCurrent ? 'current' : ''}`} onClick={() => { onToggle(); if (!open && views[0]) navigate(`/base/${base.id}/table/${table.id}/view/${views[0].id}`); }}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="sb-chevron" />
          <Icon name="table" size={14} />
          <span className="sb-label">{table.title}</span>
        </button>
        {canEdit && (
          <Dropdown label={<Icon name="more" size={14} />} buttonClassName="sb-more" className="menu">
            {(close) => (
              <>
                {VIEW_TYPES.map((vt) => (
                  <MenuItem key={vt} icon={<ViewIcon type={vt} />} onClick={() => { close(); void addView(vt); }}>
                    {t('New {type} view', { type: t(VIEW_LABELS[vt]) })}
                  </MenuItem>
                ))}
                <MenuDivider />
                <MenuItem icon={<Icon name="upload" />} onClick={() => { close(); setImporting(true); }}>
                  {t('Import into this table')}
                </MenuItem>
                <MenuItem icon={<Icon name="edit" />} onClick={() => { close(); void rename(); }}>
                  {t('Rename')}
                </MenuItem>
                <MenuItem icon={<Icon name="trash" />} danger onClick={() => { close(); void remove(); }}>
                  {t('Delete table')}
                </MenuItem>
              </>
            )}
          </Dropdown>
        )}
      </div>
      {open && (
        <div className="sb-views">
          {views.map((v) => (
            <ViewItem key={v.id} base={base} table={table} view={v} canEdit={canEdit} count={views.length} />
          ))}
          {canEdit && (
            <Dropdown label={<><Icon name="plus" size={12} /> {t('Create view')}</>} buttonClassName="sb-item sb-add" className="menu">
              {(close) => (
                <>
                  {VIEW_TYPES.map((vt) => (
                    <MenuItem key={vt} icon={<ViewIcon type={vt} />} onClick={() => { close(); void addView(vt); }}>
                      {t(VIEW_LABELS[vt])}
                    </MenuItem>
                  ))}
                </>
              )}
            </Dropdown>
          )}
        </div>
      )}
      {importing && <ImportDialog baseId={base.id} tableId={table.id} onClose={() => setImporting(false)} />}
    </div>
  );
}

function BaseTree({ base }: { base: Base }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const params = useRouteIds();
  const full = useBase(base.id);
  const perms = permissionsFor(full.data?.role ?? base.role);
  const [openTables, setOpenTables] = useState<Set<string>>(() => new Set(params.tableId ? [params.tableId] : []));
  const tables = [...(full.data?.tables ?? [])].sort((a, b) => a.order - b.order);
  if (params.tableId && !openTables.has(params.tableId) && tables.some((tb) => tb.id === params.tableId)) {
    setOpenTables(new Set([...openTables, params.tableId]));
  }

  const addTable = async () => {
    const title = await promptDialog({ title: t('New table'), label: t('Table name'), confirmLabel: t('Create') });
    if (!title) return;
    try {
      const tb = await metaApi.createTable(base.id, { title });
      await qc.invalidateQueries({ queryKey: qk.base(base.id) });
      setOpenTables((s) => new Set([...s, tb.id]));
      navigate(`/base/${base.id}/table/${tb.id}`);
    } catch (e) {
      toastError(e);
    }
  };

  if (full.isLoading) return <div className="sb-loading">{t('Loading…')}</div>;
  if (full.isError) return <div className="sb-loading error-text">{(full.error as Error).message}</div>;
  return (
    <div className="sb-tables">
      {tables.map((tb) => (
        <TableItem
          key={tb.id}
          base={base}
          table={tb}
          canEdit={perms.canEdit}
          open={openTables.has(tb.id)}
          onToggle={() =>
            setOpenTables((s) => {
              const n = new Set(s);
              if (n.has(tb.id)) n.delete(tb.id);
              else n.add(tb.id);
              return n;
            })
          }
        />
      ))}
      {!tables.length && <div className="sb-loading muted">{t('No tables yet')}</div>}
      {perms.canEdit && (
        <button className="sb-item sb-add" onClick={addTable}>
          <Icon name="plus" size={12} /> {t('New table')}
        </button>
      )}
    </div>
  );
}

function BaseItem({ base, open, onToggle }: { base: Base; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const params = useRouteIds();
  const perms = permissionsFor(base.role);
  const [importing, setImporting] = useState(false);
  const rename = async () => {
    const title = await promptDialog({ title: t('Rename base'), initial: base.title });
    if (!title) return;
    try {
      await metaApi.updateBase(base.id, { title });
      await qc.invalidateQueries({ queryKey: qk.bases });
      await qc.invalidateQueries({ queryKey: qk.base(base.id) });
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: t('Delete base “{name}”?', { name: base.title }), message: t('All tables and records in this base will be permanently deleted.'), confirmLabel: t('Delete base'), danger: true }))) return;
    try {
      await metaApi.deleteBase(base.id);
      await qc.invalidateQueries({ queryKey: qk.bases });
      if (params.baseId === base.id) navigate('/');
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className={`sb-base ${params.baseId === base.id ? 'current' : ''}`}>
      <div className="sb-item-row">
        <button className="sb-item sb-base-item" onClick={onToggle}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="sb-chevron" />
          <span className="base-dot" style={{ background: base.color || 'var(--accent)' }} />
          <span className="sb-label">{base.title}</span>
        </button>
        <Dropdown label={<Icon name="more" size={14} />} buttonClassName="sb-more" className="menu">
          {(close) => (
            <>
              <MenuItem icon={<Icon name="settings" />} onClick={() => { close(); navigate(`/base/${base.id}/settings`); }}>
                {t('Members & audit')}
              </MenuItem>
              {perms.canEdit && (
                <MenuItem icon={<Icon name="upload" />} onClick={() => { close(); setImporting(true); }}>
                  {t('Import CSV / Excel')}
                </MenuItem>
              )}
              {perms.isOwner && (
                <>
                  <MenuItem icon={<Icon name="edit" />} onClick={() => { close(); void rename(); }}>
                    {t('Rename')}
                  </MenuItem>
                  <MenuDivider />
                  <MenuItem icon={<Icon name="trash" />} danger onClick={() => { close(); void remove(); }}>
                    {t('Delete base')}
                  </MenuItem>
                </>
              )}
            </>
          )}
        </Dropdown>
      </div>
      {open && <BaseTree base={base} />}
      {importing && <ImportDialog baseId={base.id} onClose={() => setImporting(false)} />}
    </div>
  );
}

/** Left sidebar: bases → tables → views, with creation and management menus. */
export function Sidebar() {
  const bases = useBases();
  const params = useRouteIds();
  const actions = useSidebarActions();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(loadExpanded()));
  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState<'import' | 'migrate' | null>(null);
  const isOpen = (id: string) => expanded.has(id) || params.baseId === id;
  const toggle = (id: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (isOpen(id)) n.delete(id);
      else n.add(id);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify([...n]));
      } catch {
        /* ignore */
      }
      return n;
    });
  };
  // A base the URL points at is always open; collapsing it is remembered via `expanded` only for others.
  const list = [...(bases.data ?? [])].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)).filter((b) => b.title.toLowerCase().includes(filter.toLowerCase()));

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <span className="sb-title">{t('Bases')}</span>
        <Dropdown label={<Icon name="plus" size={15} />} buttonClassName="sb-more sb-new" className="menu" title={t('New')}>
          {(close) => (
            <>
              <MenuItem icon={<Icon name="database" />} onClick={() => { close(); void actions.createBase(); }}>
                {t('New empty base')}
              </MenuItem>
              <MenuItem icon={<Icon name="template" />} onClick={() => { close(); void actions.createFromTemplate(); }}>
                {t('New from Inventory template')}
              </MenuItem>
              <MenuDivider />
              <MenuItem icon={<Icon name="upload" />} onClick={() => { close(); setDialog('import'); }}>
                {t('Import CSV / Excel')}
              </MenuItem>
              <MenuItem icon={<Icon name="migrate" />} onClick={() => { close(); setDialog('migrate'); }}>
                {t('Migrate from NocoDB')}
              </MenuItem>
            </>
          )}
        </Dropdown>
      </div>
      {(bases.data?.length ?? 0) > 6 && (
        <div className="sb-filter">
          <input className="input input-sm" placeholder={t('Filter bases')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className="sb-scroll">
        {bases.isLoading && <div className="sb-loading">{t('Loading…')}</div>}
        {list.map((b) => (
          <BaseItem key={b.id} base={b} open={isOpen(b.id)} onToggle={() => toggle(b.id)} />
        ))}
        {bases.data && !bases.data.length && (
          <div className="sb-empty">
            <p className="muted small">{t('No bases yet.')}</p>
            <button className="btn btn-primary btn-sm" onClick={actions.createFromTemplate}>
              <Icon name="template" size={13} /> {t('New from Inventory template')}
            </button>
          </div>
        )}
      </div>
      <div className="sb-foot">
        <button className="sb-item" onClick={() => setDialog('import')}>
          <Icon name="upload" size={14} /> {t('Import CSV / Excel')}
        </button>
        <button className="sb-item" onClick={() => setDialog('migrate')}>
          <Icon name="migrate" size={14} /> {t('Migrate from NocoDB')}
        </button>
      </div>
      {dialog === 'import' && <ImportDialog onClose={() => setDialog(null)} />}
      {dialog === 'migrate' && <MigrateDialog onClose={() => setDialog(null)} />}
    </aside>
  );
}
