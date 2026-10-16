import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PageHead } from '../components/shell/PageHead';
import { t } from '../i18n';
import { useAuth } from '../lib/auth';
import { OpenBaoPage } from './OpenBaoPage';
import { PostgresPage } from './PostgresPage';
import { SpaPage } from './SpaPage';
import { StatusPage } from './StatusPage';
import { Banner } from './ui';

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <>
      <PageHead title={title} subtitle={subtitle} />
      {children}
    </>
  );
}

/** System settings, for DCIM/IPAM administrators; the menu entries are in the Settings group of the sidebar. */
export function SettingsPage() {
  const { account } = useAuth();
  if (account && !account.admin)
    return (
      <div className="page settings-page">
        <Banner kind="error" title={t('Only administrators can open the settings.')} />
      </div>
    );
  return (
    <div className="page settings-page">
      <Routes>
        <Route index element={<Navigate to="status" replace />} />
        <Route path="status" element={<StatusPage />} />
        <Route
          path="keystone"
          element={
            <Section title="Keystone" subtitle={t('Sign-in and access are managed in Keystone.')}>
              <SpaPage />
            </Section>
          }
        />
        {/* Older addresses of this page; /settings/spa is the one from before SPA was renamed to Keystone. */}
        <Route path="spa" element={<Navigate to="../keystone" replace />} />
        <Route path="identity" element={<Navigate to="../keystone" replace />} />
        <Route path="directory" element={<Navigate to="../keystone" replace />} />
        <Route path="password-policy" element={<Navigate to="../keystone" replace />} />
        <Route
          path="postgresql"
          element={
            <Section title="PostgreSQL" subtitle={t('The database connection, its statistics and moving to another server.')}>
              <PostgresPage />
            </Section>
          }
        />
        <Route
          path="openbao"
          element={
            <Section title="OpenBao" subtitle={t('Where Ledger keeps its secrets.')}>
              <OpenBaoPage />
            </Section>
          }
        />
        <Route path="*" element={<Navigate to="status" replace />} />
      </Routes>
    </div>
  );
}
