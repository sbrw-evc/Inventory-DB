import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PageHead } from '../components/shell/PageHead';
import { t } from '../i18n';
import { useAuth } from '../lib/auth';
import { DirectoryPage } from './DirectoryPage';
import { OpenBaoPage } from './OpenBaoPage';
import { PolicyPage } from './PolicyPage';
import { PostgresPage } from './PostgresPage';
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
          path="directory"
          element={
            <Section title={t('Sign-in')} subtitle={t('Sign-in with LDAP / Active Directory and Microsoft Entra ID.')}>
              <DirectoryPage />
            </Section>
          }
        />
        <Route
          path="password-policy"
          element={
            <Section title={t('Password policy')} subtitle={t('Rules for the passwords of local accounts.')}>
              <PolicyPage />
            </Section>
          }
        />
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
            <Section title="OpenBao" subtitle={t('Where Inventory DB keeps its secrets.')}>
              <OpenBaoPage />
            </Section>
          }
        />
        <Route path="*" element={<Navigate to="status" replace />} />
      </Routes>
    </div>
  );
}
