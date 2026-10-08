import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { AppHeader } from '../components/AppHeader';
import { Sidebar } from '../components/Sidebar';
import { t } from '../i18n';
import { useAuth } from '../lib/auth';

/** Signed-in shell: navy header on top of every section. */
export function AppLayout() {
  const { token, loading } = useAuth();
  const location = useLocation();
  if (!token) return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  if (loading) return <div className="boot">{t('Loading…')}</div>;
  return (
    <div className="app">
      <AppHeader />
      <div className="app-main">
        <Outlet />
      </div>
    </div>
  );
}

/** Spreadsheet area: bases sidebar + content. */
export function BasesLayout() {
  return (
    <div className="bases-layout">
      <Sidebar />
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
