import { useMemo } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useBase } from '../api/hooks';
import { Icon } from '../components/Icon';
import { t } from '../i18n';
import { BaseDataContext, type BaseData } from '../lib/baseContext';
import { permissionsFor } from '../lib/roles';
import { BaseSettings } from './BaseSettings';
import { TableViewPage } from './TableViewPage';

export function BasePage() {
  const { baseId } = useParams();
  const base = useBase(baseId);
  const ctx = useMemo<BaseData | null>(
    () => (base.data ? { baseId: base.data.id, tables: base.data.tables, perms: permissionsFor(base.data.role), isPublic: false } : null),
    [base.data],
  );
  if (base.isLoading) return <div className="view-loading">{t('Loading…')}</div>;
  if (base.isError || !base.data || !ctx)
    return (
      <div className="empty-state">
        <Icon name="database" size={32} />
        <h3>{t('Base not available')}</h3>
        <p className="muted">{(base.error as Error | null)?.message}</p>
      </div>
    );
  const data = base.data;
  const firstTable = [...data.tables].sort((a, b) => a.order - b.order)[0];
  const firstView = firstTable ? [...(firstTable.views ?? [])].sort((a, b) => a.order - b.order)[0] : undefined;

  return (
    <BaseDataContext.Provider value={ctx}>
      <Routes>
        <Route
          index
          element={
            firstTable ? (
              <Navigate to={firstView ? `table/${firstTable.id}/view/${firstView.id}` : `table/${firstTable.id}`} replace />
            ) : (
              <div className="empty-state">
                <Icon name="table" size={32} />
                <h3>{t('{name} has no tables yet', { name: data.title })}</h3>
                <p className="muted">{ctx.perms.canEdit ? t('Create a table or import a spreadsheet from the sidebar.') : t('Ask an editor to add tables.')}</p>
              </div>
            )
          }
        />
        <Route path="table/:tableId" element={<TableViewPage base={data} />} />
        <Route path="table/:tableId/view/:viewId" element={<TableViewPage base={data} />} />
        <Route path="settings" element={<BaseSettings base={data} />} />
        <Route path="*" element={<Navigate to="." replace />} />
      </Routes>
    </BaseDataContext.Provider>
  );
}
