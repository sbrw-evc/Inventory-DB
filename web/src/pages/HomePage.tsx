import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useBases } from '../api/hooks';
import { useSidebarActions } from '../components/Sidebar';
import { PageHead } from '../components/shell/PageHead';
import { Icon } from '../components/Icon';
import { ImportDialog } from '../components/ImportDialog';
import { MigrateDialog } from '../components/MigrateDialog';
import { getLang, t } from '../i18n';
import { useAuth } from '../lib/auth';
import { permissionsFor } from '../lib/roles';

export function HomePage() {
  const bases = useBases();
  const { user } = useAuth();
  const actions = useSidebarActions();
  const [dialog, setDialog] = useState<'import' | 'migrate' | null>(null);
  const list = bases.data ?? [];
  const counts = { total: list.length, owner: list.filter((b) => b.role === 'owner').length, shared: list.filter((b) => b.role !== 'owner').length };

  return (
    <div className="page home">
      <PageHead title={t('Welcome, {name}', { name: user?.name || user?.email || '' })} subtitle={t('Spreadsheet bases of your inventory, the DCIM and IPAM catalog and the integrations that feed them.')} />
      <div className="counters">
        <div className="counter info">
          <span className="counter-num">{counts.total}</span>
          <span className="counter-label">{t('Bases')}</span>
        </div>
        <div className="counter ok">
          <span className="counter-num">{counts.owner}</span>
          <span className="counter-label">{t('Owned by you')}</span>
        </div>
        <div className="counter">
          <span className="counter-num">{counts.shared}</span>
          <span className="counter-label">{t('Shared with you')}</span>
        </div>
      </div>
      <div className="quick-actions">
        <button className="quick-card" onClick={actions.createFromTemplate}>
          <Icon name="template" size={20} />
          <b>{t('New from Inventory template')}</b>
          <span className="muted small">{t('Products, suppliers, warehouses and stock movements, already linked.')}</span>
        </button>
        <button className="quick-card" onClick={actions.createBase}>
          <Icon name="database" size={20} />
          <b>{t('New empty base')}</b>
          <span className="muted small">{t('Start from scratch and add your own tables.')}</span>
        </button>
        <button className="quick-card" onClick={() => setDialog('import')}>
          <Icon name="upload" size={20} />
          <b>{t('Import CSV / Excel')}</b>
          <span className="muted small">{t('Turn a spreadsheet into a table.')}</span>
        </button>
        <button className="quick-card" onClick={() => setDialog('migrate')}>
          <Icon name="migrate" size={20} />
          <b>{t('Migrate from NocoDB')}</b>
          <span className="muted small">{t('Copy a base with its tables, records, links and views.')}</span>
        </button>
      </div>
      {list.length > 0 && (
        <>
          <h2 className="section-title">{t('Your bases')}</h2>
          <div className="table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('Name')}</th>
                <th>{t('Description')}</th>
                <th>{t('Your role')}</th>
                <th>{t('Created')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link to={`/base/${b.id}`} className="row-flex">
                      <span className="base-dot" style={{ background: b.color || 'var(--accent)' }} />
                      {b.title}
                    </Link>
                  </td>
                  <td className="muted">{b.description}</td>
                  <td>
                    <span className={`pill ${permissionsFor(b.role).isOwner ? 'pill-ok' : permissionsFor(b.role).canEdit ? 'pill-info' : ''}`}>{t(b.role ?? 'viewer')}</span>
                  </td>
                  <td className="muted">{new Date(b.createdAt).toLocaleDateString(getLang())}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
      {dialog === 'import' && <ImportDialog onClose={() => setDialog(null)} />}
      {dialog === 'migrate' && <MigrateDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
