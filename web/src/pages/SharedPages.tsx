import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import type { ListResult, RecordData, Sort } from '@shared';
import { ApiRequestError } from '../api/client';
import { publicApi, type PublicViewData } from '../api/endpoints';
import { ExpandedRecord } from '../components/ExpandedRecord';
import { Icon, ViewIcon } from '../components/Icon';
import { Brand, Preferences } from '../components/shell/Brand';
import { t } from '../i18n';
import { BaseDataContext, type BaseData } from '../lib/baseContext';
import { publicSource } from '../lib/records';
import { PUBLIC_PERMISSIONS } from '../lib/roles';
import { useDebounced } from '../lib/useDebounced';
import { resolveViewColumns } from '../lib/viewColumns';
import { FormRenderer } from '../views/FormRenderer';
import { GalleryView } from '../views/GalleryView';
import { GridView } from '../views/grid/GridView';
import { KanbanView } from '../views/KanbanView';
import { CalendarView, MapView, TimelineView } from '../views/lazyViews';

const pwKey = (uuid: string) => `inventorydb.sharepw.${uuid}`;

function readPw(uuid: string): string | null {
  try {
    return sessionStorage.getItem(pwKey(uuid));
  } catch {
    return null;
  }
}

function usePublicView(uuid: string) {
  const [password, setPassword] = useState<string | null>(() => readPw(uuid));
  const query = useQuery({
    queryKey: ['public', uuid, password],
    queryFn: () => publicApi.getView(uuid, password),
    retry: false,
  });
  const err = query.error as ApiRequestError | null;
  const needsPassword = !!err && (err.status === 401 || err.status === 403);
  const submitPassword = (pw: string) => {
    try {
      sessionStorage.setItem(pwKey(uuid), pw);
    } catch {
      /* ignore */
    }
    setPassword(pw);
  };
  return { query, password, needsPassword, wrongPassword: needsPassword && !!password, submitPassword };
}

function PublicShell({ title, type, children }: { title?: string; type?: PublicViewData['view']['type']; children: React.ReactNode }) {
  return (
    <div className="public-page">
      <header className="topbar">
        <div className="topbar-start">
          <Brand />
          {title && (
            <span className="header-public-title">
              {type && <ViewIcon type={type} />} {title}
            </span>
          )}
        </div>
        <div className="topbar-end">
          <Preferences />
        </div>
      </header>
      <div className="public-body">{children}</div>
    </div>
  );
}

function PasswordPrompt({ wrong, onSubmit }: { wrong: boolean; onSubmit: (pw: string) => void }) {
  const [pw, setPw] = useState('');
  return (
    <div className="auth-center">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (pw) onSubmit(pw);
        }}
      >
        <h1>
          <Icon name="lock" size={20} /> {t('Password required')}
        </h1>
        <p className="muted">{t('This shared view is protected. Enter the password you were given.')}</p>
        <input className="input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t('Password')} />
        {wrong && <div className="notice notice-error">{t('Wrong password')}</div>}
        <button className="btn btn-primary btn-block">{t('Open')}</button>
      </form>
    </div>
  );
}

function Unavailable({ error }: { error: Error | null }) {
  return (
    <div className="empty-state">
      <Icon name="eyeOff" size={32} />
      <h3>{t('This link is not available')}</h3>
      <p className="muted">{error?.message ?? t('The view may have been unshared or deleted.')}</p>
    </div>
  );
}

function SharedViewBody({ data, uuid, password }: { data: PublicViewData; uuid: string; password: string | null }) {
  const qc = useQueryClient();
  const { view, table } = data;
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [sorts, setSorts] = useState<Sort[] | undefined>(undefined);
  const [open, setOpen] = useState<RecordData | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const ctx = useMemo<BaseData>(() => ({ baseId: null, tables: [table], perms: PUBLIC_PERMISSIONS, isPublic: true }), [table]);
  const source = useMemo(() => publicSource(table.id, uuid, password), [table.id, uuid, password]);
  const resolved = useMemo(() => resolveViewColumns(table.columns, view.columns, view.type), [table.columns, view.columns, view.type]);
  const baseQuery = useMemo(() => ({ search: debounced || undefined, sorts }), [debounced, sorts]);

  const openById = (id: number) => {
    for (const [, d] of qc.getQueriesData<InfiniteData<ListResult> | ListResult>({ queryKey: source.key })) {
      const lists = d ? ('pages' in d ? d.pages.map((p) => p.list) : [d.list]) : [];
      for (const l of lists) {
        const row = l.find((r) => r.id === id);
        if (row) return setOpen(row);
      }
    }
  };

  let body: React.ReactNode;
  switch (view.type) {
    case 'gallery':
      body = <GalleryView table={table} view={view} resolved={resolved} source={source} baseQuery={baseQuery} onOpen={openById} onTotal={setTotal} />;
      break;
    case 'kanban':
      body = (
        <KanbanView table={table} view={view} resolved={resolved} source={source} baseQuery={baseQuery} perms={PUBLIC_PERMISSIONS} onOpen={openById} onAdd={() => {}} onChooseField={() => {}} />
      );
      break;
    case 'calendar':
      body = <CalendarView table={table} view={view} source={source} baseQuery={baseQuery} perms={PUBLIC_PERMISSIONS} onOpen={openById} onAdd={() => {}} />;
      break;
    case 'timeline':
      body = <TimelineView table={table} view={view} source={source} baseQuery={baseQuery} perms={PUBLIC_PERMISSIONS} onOpen={openById} onAdd={() => {}} />;
      break;
    case 'map':
      body = <MapView table={table} view={view} resolved={resolved} source={source} baseQuery={baseQuery} onOpen={openById} />;
      break;
    default:
      body = (
        <GridView
          table={table}
          view={view}
          resolved={resolved}
          sorts={sorts ?? view.sorts ?? []}
          source={source}
          baseQuery={baseQuery}
          perms={PUBLIC_PERMISSIONS}
          canEditView={false}
          actions={{ setColumns: () => {}, setSorts: setSorts, setGroupBy: () => {} }}
          onExpand={openById}
          onTotal={setTotal}
        />
      );
  }

  return (
    <BaseDataContext.Provider value={ctx}>
      <div className="view-host">
        <div className="toolbar">
          <div className="toolbar-view-name">
            <ViewIcon type={view.type} /> {table.title} · {view.title}
          </div>
          <div className="toolbar-search">
            <Icon name="search" size={14} />
            <input placeholder={t('Search in view')} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <span className="spacer" />
          {total !== null && <span className="muted small">{total === 1 ? t('1 record') : t('{n} records', { n: total })}</span>}
          <span className="live-indicator">
            <span className="live-dot" /> {t('Read-only view')}
          </span>
        </div>
        <div className="view-body">{body}</div>
      </div>
      {open && <ExpandedRecord table={table} recordId={open.id} initialRow={open} resolved={resolved} onClose={() => setOpen(null)} />}
    </BaseDataContext.Provider>
  );
}

export function SharedViewPage() {
  const { shareUuid = '' } = useParams();
  const { query, password, needsPassword, wrongPassword, submitPassword } = usePublicView(shareUuid);
  if (query.data?.view.type === 'form') return <Navigate to={`/shared/form/${shareUuid}`} replace />;
  return (
    <PublicShell title={query.data ? `${query.data.table.title} · ${query.data.view.title}` : undefined} type={query.data?.view.type}>
      {query.isLoading && <div className="view-loading">{t('Loading…')}</div>}
      {needsPassword && <PasswordPrompt wrong={wrongPassword} onSubmit={submitPassword} />}
      {query.isError && !needsPassword && <Unavailable error={query.error as Error} />}
      {query.data && <SharedViewBody data={query.data} uuid={shareUuid} password={password} />}
    </PublicShell>
  );
}

export function SharedFormPage() {
  const { shareUuid = '' } = useParams();
  const { query, password, needsPassword, wrongPassword, submitPassword } = usePublicView(shareUuid);
  const data = query.data;
  const ctx = useMemo<BaseData | null>(() => (data ? { baseId: null, tables: [data.table], perms: { ...PUBLIC_PERMISSIONS, canEdit: true }, isPublic: true } : null), [data]);
  const fields = useMemo(() => (data ? resolveViewColumns(data.table.columns, data.view.columns, 'form').filter((r) => r.show) : []), [data]);
  return (
    <PublicShell>
      {query.isLoading && <div className="view-loading">{t('Loading…')}</div>}
      {needsPassword && <PasswordPrompt wrong={wrongPassword} onSubmit={submitPassword} />}
      {query.isError && !needsPassword && <Unavailable error={query.error as Error} />}
      {data && ctx && (
        <BaseDataContext.Provider value={ctx}>
          <div className="form-canvas public">
            <FormRenderer table={data.table} view={data.view} fields={fields} onSubmit={(values) => publicApi.submitForm(shareUuid, values, password)} />
          </div>
        </BaseDataContext.Provider>
      )}
    </PublicShell>
  );
}
