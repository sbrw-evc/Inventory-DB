import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { platformApi } from '../api/endpoints';
import { qk } from '../api/hooks';
import { confirmDialog } from '../components/dialogs';
import { Icon } from '../components/Icon';
import { ImportDialog } from '../components/ImportDialog';
import { MigrateDialog } from '../components/MigrateDialog';
import { copyText } from '../components/ShareDialog';
import { PageHead } from '../components/shell/PageHead';
import { t } from '../i18n';
import { relativeTime } from '../lib/format';
import { toastError } from '../lib/toast';

function Tokens() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: qk.tokens, queryFn: platformApi.listTokens });
  const [description, setDescription] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const tok = await platformApi.createToken(description.trim());
      setCreated(tok.token ?? null);
      setDescription('');
      await qc.invalidateQueries({ queryKey: qk.tokens });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <PageHead
        title={t('API tokens')}
        subtitle={
          <>
            {t('Use a token to call the REST API: send it in the')} <code>xc-token</code> {t('header.')}{' '}
            <a href="/api/v1/docs" target="_blank" rel="noreferrer">
              {t('API documentation')}
            </a>
          </>
        }
      />
      <form className="invite-row" onSubmit={create}>
        <input className="input" required placeholder={t('What is this token for?')} value={description} onChange={(e) => setDescription(e.target.value)} />
        <button className="btn btn-primary" disabled={busy || !description.trim()}>
          <Icon name="plus" size={13} /> {t('Create token')}
        </button>
      </form>
      {created && (
        <div className="notice notice-success token-once">
          <div>
            <b>{t('Copy your token now — it won’t be shown again.')}</b>
          </div>
          <div className="share-link">
            <input className="input mono" readOnly value={created} onFocus={(e) => e.target.select()} />
            <button className="btn btn-primary" onClick={() => copyText(created)}>
              <Icon name="copy" size={13} /> {t('Copy')}
            </button>
          </div>
        </div>
      )}
      <div className="table-card">
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('Description')}</th>
            <th>{t('Created')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tokens.data?.map((tok) => (
            <tr key={tok.id}>
              <td>
                <Icon name="key" size={13} /> {tok.description}
              </td>
              <td className="muted">{relativeTime(tok.createdAt)}</td>
              <td className="actions-cell">
                <button
                  className="icon-btn"
                  title={t('Delete')}
                  onClick={async () => {
                    if (!(await confirmDialog({ title: t('Delete token “{name}”?', { name: tok.description }), message: t('Apps using it will stop working.'), danger: true, confirmLabel: t('Delete') }))) return;
                    try {
                      await platformApi.deleteToken(tok.id);
                      await qc.invalidateQueries({ queryKey: qk.tokens });
                    } catch (err) {
                      toastError(err);
                    }
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tokens.data && !tokens.data.length && <div className="empty-state-sm">{t('No tokens yet')}</div>}
      </div>
    </section>
  );
}

function DataTools() {
  const [dialog, setDialog] = useState<'import' | 'migrate' | null>(null);
  return (
    <section className="settings-section">
      <PageHead title={t('Data import & migration')} subtitle={t('Bring spreadsheets and NocoDB bases into Inventory DB.')} />
      <div className="quick-actions">
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
      {dialog === 'import' && <ImportDialog onClose={() => setDialog(null)} />}
      {dialog === 'migrate' && <MigrateDialog onClose={() => setDialog(null)} />}
    </section>
  );
}

/** Administration pages; their menu entries are in the Administration and Integrations groups of the sidebar. */
export function AdminPage() {
  return (
    <div className="page">
      <Routes>
        <Route index element={<Navigate to="tokens" replace />} />
        <Route path="tokens" element={<Tokens />} />
        <Route path="data" element={<DataTools />} />
      </Routes>
    </div>
  );
}
