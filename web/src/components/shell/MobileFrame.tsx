import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, HardDrive, LayoutGrid, Menu, Monitor, Network, Search, type LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { Link, useLocation } from 'react-router-dom';
import { useBases } from '../../api/hooks';
import { useT } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { pageLabel } from './AppSidebar';
import { spring } from './Brand';
import { DesktopOnly, forcedPages } from './DesktopOnly';
import { mobileReady, MORE_TILES, navGroups, pageOf } from './mobilePages';
import { basesOwn, owns, type NavGroup, type NavPage } from './nav';
import { Sheet } from './Sheet';
import { UserMenu } from './UserMenu';

type Tab = { to: string; label: string; icon: LucideIcon; active: (p: string) => boolean };

const OBJECTS = ['/dcim', '/tenancy', '/circuits', '/virtualization'];

// The tab bar: the bases, search, the DCIM and IPAM catalogs, then "More" (as Beacon's tab bar).
const TABS: Tab[] = [
  { to: '/', label: 'Bases', icon: LayoutGrid, active: basesOwn },
  { to: '/dcim/search', label: 'Search', icon: Search, active: (p) => p.startsWith('/dcim/search') },
  { to: '/dcim/devices', label: 'DCIM', icon: HardDrive, active: (p) => !p.startsWith('/dcim/search') && OBJECTS.some((x) => p.startsWith(x)) },
  { to: '/ipam/prefixes', label: 'IPAM', icon: Network, active: (p) => p.startsWith('/ipam') },
];

function useTitle(groups: NavGroup[]) {
  const t = useT();
  const { pathname } = useLocation();
  const bases = useBases();
  const baseId = /^\/base\/([^/]+)/.exec(pathname)?.[1];
  if (baseId) return bases.data?.find((b) => b.id === baseId)?.title ?? t('Bases');
  if (pathname === '/') return t('Bases');
  const page = pageOf(groups, pathname);
  return page ? pageLabel(page, t) : 'Ledger';
}

/**
 * The phone shell (Beacon's MobileFrame): a top bar with the page title, the page, and a tab bar
 * at the bottom; "More" opens every other section in a bottom sheet, with the sections made for a
 * computer apart. Those pages show a note on the phone and open only on request.
 */
export function MobileFrame({ children }: { children: ReactNode }) {
  const t = useT();
  const { pathname } = useLocation();
  const groups = navGroups(!!useAuth().account?.admin);
  const title = useTitle(groups);
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [pathname]);
  const inTabs = TABS.some((tab) => tab.active(pathname));
  return (
    <div className="m-shell">
      <header className="m-top">
        <Link to="/" className="m-top-brand" aria-label="Ledger">
          <img src="/logo.svg" alt="" width={28} height={28} />
        </Link>
        <h1 className="m-top-title">{title}</h1>
        <div className="m-top-end">
          <UserMenu compact />
        </div>
      </header>
      <div className="m-main">
        <PhonePage groups={groups}>{children}</PhonePage>
      </div>
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
      <MoreSheet open={more} onClose={() => setMore(false)} groups={groups} />
    </div>
  );
}

/** PhonePage keeps the pages made for a computer behind a note (Beacon's Pages). */
function PhonePage({ groups, children }: { groups: NavGroup[]; children: ReactNode }) {
  const t = useT();
  const { pathname } = useLocation();
  const [forced, setForced] = useState(forcedPages);
  const page = pageOf(groups, pathname);
  if (page && !mobileReady(page.to) && !forced.has(page.to)) return <DesktopOnly id={page.to} label={pageLabel(page, t)} icon={page.icon} onOpen={() => setForced(forcedPages())} />;
  return <>{children}</>;
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

/**
 * MoreSheet (Beacon's): the objects looked up most as tiles, then every catalog section by group,
 * then the sections better opened on a computer.
 */
function MoreSheet({ open, onClose, groups }: { open: boolean; onClose: () => void; groups: NavGroup[] }) {
  const t = useT();
  const { pathname } = useLocation();
  const pages = groups.flatMap((g) => g.pages);
  const tiles = MORE_TILES.flatMap((id) => pages.find((p) => p.id === id) ?? []);
  const listed = (g: NavGroup) => g.pages.filter((p) => p.id !== 'dcim/search' && !tiles.includes(p));
  const phone = groups.map((g) => ({ ...g, pages: listed(g).filter((p) => mobileReady(p.to)) })).filter((g) => g.pages.length > 0);
  const desk = groups.map((g) => ({ ...g, pages: listed(g).filter((p) => !mobileReady(p.to)) })).filter((g) => g.pages.length > 0);
  const row = (p: NavPage, muted = false) => (
    <Link key={p.id} to={p.to} className={`m-more-row${owns(p, pathname) ? ' active' : ''}`}>
      <p.icon size={muted ? 17 : 18} aria-hidden />
      <span>{pageLabel(p, t)}</span>
      <ChevronRight size={16} aria-hidden className="m-more-chev" />
    </Link>
  );
  return (
    <Sheet open={open} title={t('All sections')} onClose={onClose}>
      {tiles.length > 0 && (
        <div className="m-more-grid">
          {tiles.map((p) => (
            <Link key={p.id} to={p.to} className={`m-more-tile${owns(p, pathname) ? ' active' : ''}`}>
              <span className="m-more-icon">
                <p.icon size={20} aria-hidden />
              </span>
              <span>{pageLabel(p, t)}</span>
            </Link>
          ))}
        </div>
      )}
      {phone.map((g) => (
        <div key={g.id} className="m-more-section">
          <h4 className="m-more-group">{t(g.title)}</h4>
          {g.pages.map((p) => row(p))}
        </div>
      ))}
      {desk.length > 0 && (
        <section className="m-more-desk">
          <h3>
            <Monitor size={15} aria-hidden />
            {t('Better on a computer')}
          </h3>
          <p className="muted">{t('Integrations, imports, administration and settings')}</p>
          {desk.map((g) => (
            <div key={g.id} className="m-more-list">
              <h4 className="m-more-group">{t(g.title)}</h4>
              {g.pages.map((p) => row(p, true))}
            </div>
          ))}
        </section>
      )}
    </Sheet>
  );
}
