import { Navigate, Route, Routes } from 'react-router-dom';
import { DialogHost } from './components/dialogs';
import { useLang } from './i18n';
import { Toasts } from './lib/toast';
import { AdminPage } from './pages/AdminPage';
import { AppLayout, BasesLayout } from './pages/AppLayout';
import { AuthPage } from './pages/AuthPage';
import { BasePage } from './pages/BasePage';
import { HomePage } from './pages/HomePage';
import { NetboxPlaceholder } from './pages/NetboxPlaceholder';
import { SharedFormPage, SharedViewPage } from './pages/SharedPages';

export function App() {
  // Re-mount on language change so every string re-renders in the new language.
  const lang = useLang();
  return (
    <div key={lang} className="app-root">
      <Routes>
        <Route path="/signin" element={<AuthPage mode="signin" />} />
        <Route path="/signup" element={<AuthPage mode="signup" />} />
        <Route path="/shared/view/:shareUuid" element={<SharedViewPage />} />
        <Route path="/shared/form/:shareUuid" element={<SharedFormPage />} />
        <Route element={<AppLayout />}>
          <Route element={<BasesLayout />}>
            <Route index element={<HomePage />} />
            <Route path="/base/:baseId/*" element={<BasePage />} />
          </Route>
          {/* DCIM / IPAM mount points: replace NetboxPlaceholder with the netbox module's routes. */}
          <Route path="/dcim/*" element={<NetboxPlaceholder section="DCIM" />} />
          <Route path="/ipam/*" element={<NetboxPlaceholder section="IPAM" />} />
          <Route path="/integrations/*" element={<NetboxPlaceholder section="Integrations" />} />
          <Route path="/admin/*" element={<AdminPage />} />
          <Route path="/account/tokens" element={<Navigate to="/admin/tokens" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <DialogHost />
      <Toasts />
    </div>
  );
}
