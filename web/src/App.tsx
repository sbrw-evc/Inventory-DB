import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { DialogHost } from './components/dialogs';
import { useLang } from './i18n';
import { Toasts } from './lib/toast';
import { AppLayout, BasesLayout } from './pages/AppLayout';
import { AuthPage } from './pages/AuthPage';
import { BasePage } from './pages/BasePage';
import { HomePage } from './pages/HomePage';

// DCIM/IPAM pages load on demand to keep the spreadsheet bundle small.
const DcimRoutes = lazy(() => import('./netbox/NetboxRoutes').then((m) => ({ default: m.DcimRoutes })));
const IpamRoutes = lazy(() => import('./netbox/NetboxRoutes').then((m) => ({ default: m.IpamRoutes })));
const TenancyRoutes = lazy(() => import('./netbox/NetboxRoutes').then((m) => ({ default: m.TenancyRoutes })));
const ExtrasRoutes = lazy(() => import('./netbox/NetboxRoutes').then((m) => ({ default: m.ExtrasRoutes })));
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));
const IntegrationsPage = lazy(() => import('./pages/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })));
const SharedViewPage = lazy(() => import('./pages/SharedPages').then((m) => ({ default: m.SharedViewPage })));
const SharedFormPage = lazy(() => import('./pages/SharedPages').then((m) => ({ default: m.SharedFormPage })));
const lazyPage = (node: ReactNode) => <Suspense fallback={null}>{node}</Suspense>;

export function App() {
  // Re-mount on language change so every string re-renders in the new language.
  const lang = useLang();
  return (
    <div key={lang} className="app-root">
      <Routes>
        <Route path="/signin" element={<AuthPage mode="signin" />} />
        <Route path="/signup" element={<AuthPage mode="signup" />} />
        <Route path="/shared/view/:shareUuid" element={lazyPage(<SharedViewPage />)} />
        <Route path="/shared/form/:shareUuid" element={lazyPage(<SharedFormPage />)} />
        <Route element={<AppLayout />}>
          <Route element={<BasesLayout />}>
            <Route index element={<HomePage />} />
            <Route path="/base/:baseId/*" element={<BasePage />} />
          </Route>
          <Route path="/dcim/*" element={lazyPage(<DcimRoutes />)} />
          <Route path="/ipam/*" element={lazyPage(<IpamRoutes />)} />
          <Route path="/tenancy/*" element={lazyPage(<TenancyRoutes />)} />
          <Route path="/extras/*" element={lazyPage(<ExtrasRoutes />)} />
          <Route path="/integrations/*" element={lazyPage(<IntegrationsPage />)} />
          <Route path="/admin/*" element={lazyPage(<AdminPage />)} />
          <Route path="/account/tokens" element={<Navigate to="/admin/tokens" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <DialogHost />
      <Toasts />
    </div>
  );
}
