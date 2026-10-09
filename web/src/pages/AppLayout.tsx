import type { CSSProperties } from 'react';
import { motion } from 'motion/react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { TopBar } from '../components/AppHeader';
import { AppSidebar, SidebarResizer, useCollapsed, useSidebarWidth } from '../components/shell/AppSidebar';
import { MobileFrame } from '../components/shell/MobileFrame';
import { t } from '../i18n';
import { useAuth } from '../lib/auth';
import { useMobile } from '../lib/useMobile';

/** The page area fades in when the section changes (Umbrella's page transition). */
function PageOutlet() {
  const { pathname } = useLocation();
  const key = pathname.split('/').slice(0, 3).join('/');
  return (
    <motion.div key={key} className="route-view" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
      <Outlet />
    </motion.div>
  );
}

/** Signed-in shell, as in Umbrella: top bar, grouped sidebar and a rounded page block. */
export function AppLayout() {
  const { token, loading } = useAuth();
  const location = useLocation();
  const mobile = useMobile();
  const [collapsed, toggle] = useCollapsed();
  const [width, setWidth] = useSidebarWidth();
  if (!token) return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  if (loading)
    return (
      <div className="boot">
        <img src="/logo.svg" alt="" width={48} height={48} />
        <p>{t('Loading…')}</p>
      </div>
    );
  if (mobile)
    return (
      <MobileFrame>
        <PageOutlet />
      </MobileFrame>
    );
  return (
    <div className="app-shell">
      <TopBar sidebar={{ collapsed, toggle }} />
      <div className={`app-body ${collapsed ? 'side-collapsed' : ''}`} style={{ '--side-width': `${width}px` } as CSSProperties}>
        <AppSidebar collapsed={collapsed} />
        {!collapsed && <SidebarResizer width={width} onChange={setWidth} />}
        <div className="app-main">
          <PageOutlet />
        </div>
      </div>
    </div>
  );
}

/** Spreadsheet area. The bases tree lives in the application sidebar, so this is the content column. */
export function BasesLayout() {
  return (
    <main className="content">
      <Outlet />
    </main>
  );
}
