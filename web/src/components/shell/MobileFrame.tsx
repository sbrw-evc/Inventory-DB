import { useEffect, useState, type ReactNode } from 'react';
import { HardDrive, LayoutGrid, Menu, Network, Plug, X, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Link, useLocation } from 'react-router-dom';
import { useBases } from '../../api/hooks';
import { useT } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { AppSidebar, pageLabel } from './AppSidebar';
import { spring } from './Brand';
import { basesOwn, navGroups, owns } from './nav';
import { UserMenu } from './UserMenu';

type Tab = { to: string; label: string; icon: LucideIcon; active: (p: string) => boolean };

const TABS: Tab[] = [
  { to: '/', label: 'Bases', icon: LayoutGrid, active: basesOwn },
  { to: '/dcim/devices', label: 'DCIM', icon: HardDrive, active: (p) => ['/dcim', '/tenancy', '/circuits', '/virtualization'].some((x) => p.startsWith(x)) },
  { to: '/ipam/prefixes', label: 'IPAM', icon: Network, active: (p) => p.startsWith('/ipam') },
  { to: '/integrations', label: 'Integrations', icon: Plug, active: (p) => p.startsWith('/integrations') },
];

function useTitle() {
  const t = useT();
  const { pathname } = useLocation();
  const bases = useBases();
  const baseId = /^\/base\/([^/]+)/.exec(pathname)?.[1];
  if (baseId) return bases.data?.find((b) => b.id === baseId)?.title ?? t('Bases');
  if (pathname === '/') return t('Bases');
  for (const g of navGroups(true)) {
    const page = [...g.pages].sort((a, b) => b.to.length - a.to.length).find((p) => owns(p, pathname));
    if (page) return pageLabel(page, t);
  }
  return 'Inventory DB';
}

/**
 * The phone shell (Umbrella MobileFrame): a top bar with the page title, the page, and a tab bar
 * at the bottom; "More" opens the whole menu in a bottom sheet.
 */
export function MobileFrame({ children }: { children: ReactNode }) {
  const t = useT();
  const { pathname } = useLocation();
  const title = useTitle();
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [pathname]);
  const inTabs = TABS.some((tab) => tab.active(pathname));
  return (
    <div className="m-shell">
      <header className="m-top">
        <Link to="/" className="m-top-brand" aria-label="Inventory DB">
          <img src="/logo.svg" alt="" width={28} height={28} />
        </Link>
        <h1 className="m-top-title">{title}</h1>
        <div className="m-top-end">
          <UserMenu compact />
        </div>
      </header>
      <div className="m-main">{children}</div>
      <nav className="m-tabs" aria-label={t('Sections')}>
        {TABS.map((tab) => {
          const active = tab.active(pathname) && !more;
          return (
            <Link key={tab.to} to={tab.to} className={`m-tab ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
              <TabInner icon={tab.icon} label={t(tab.label)} active={active} />
            </Link>
          );
        })}
        <button type="button" className={`m-tab ${more || !inTabs ? 'active' : ''}`} onClick={() => setMore(true)} aria-haspopup="dialog">
          <TabInner icon={Menu} label={t('More')} active={more || !inTabs} />
        </button>
      </nav>
      <AnimatePresence>
        {more && (
          <motion.div className="m-sheet-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={(e) => e.target === e.currentTarget && setMore(false)}>
            <motion.div className="m-sheet" role="dialog" aria-modal="true" aria-label={t('Menu')} initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', stiffness: 380, damping: 38 }}>
              <div className="m-sheet-head">
                <span className="m-sheet-grip" aria-hidden />
                <strong>{t('Menu')}</strong>
                <button type="button" className="icon-btn" onClick={() => setMore(false)} aria-label={t('Close')}>
                  <X size={18} />
                </button>
              </div>
              <AppSidebar onNavigate={() => setMore(false)} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TabInner({ icon: Icon, label, active }: { icon: LucideIcon; label: string; active: boolean }) {
  return (
    <>
      {active && <motion.span layoutId="m-tab-pill" className="m-tab-pill" transition={spring} />}
      <span className="m-tab-icon">
        <Icon size={21} aria-hidden />
      </span>
      <span className="m-tab-label">{label}</span>
    </>
  );
}
