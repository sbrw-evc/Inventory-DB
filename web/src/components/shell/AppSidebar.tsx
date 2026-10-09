import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, House } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Link, useLocation } from 'react-router-dom';
import { useT } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { t as nbT, typeLabel } from '../../netbox/i18n';
import { BasesTree } from '../Sidebar';
import { spring } from './Brand';
import { basesOwn, navGroups, owns, type NavGroup, type NavPage } from './nav';

const COMPACT = '(max-width: 860px)';
const openKey = (group: string) => `inventorydb.sidebar.${group}`;
const COLLAPSED_KEY = 'inventorydb.sidebar.collapsed';
const WIDTH_KEY = 'inventorydb.sidebar.width';
/** The width of the expanded sidebar the user can drag between these bounds (Umbrella values). */
export const SIDEBAR_WIDTH = { min: 232, max: 440, initial: 280 };
const WIDTH_STEP = 16;

function useCompact() {
  return useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia(COMPACT);
      mq.addEventListener('change', notify);
      return () => mq.removeEventListener('change', notify);
    },
    () => window.matchMedia(COMPACT).matches,
    () => false,
  );
}

function read(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string | null) {
  try {
    if (v === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, v);
  } catch {
    /* lasts until reload */
  }
}

/** Collapsed (icon rail) state of the sidebar, kept in this browser. */
export function useCollapsed() {
  const [collapsed, setCollapsed] = useState(() => read(COLLAPSED_KEY) === '1');
  const toggle = useCallback(
    () =>
      setCollapsed((v) => {
        write(COLLAPSED_KEY, v ? '0' : '1');
        return !v;
      }),
    [],
  );
  return [collapsed, toggle] as const;
}

const clampWidth = (w: number) => Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, w)));

export function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    const v = Number(read(WIDTH_KEY));
    return v > 0 ? clampWidth(v) : SIDEBAR_WIDTH.initial;
  });
  const change = useCallback((w: number) => {
    const next = clampWidth(w);
    setWidth(next);
    write(WIDTH_KEY, next === SIDEBAR_WIDTH.initial ? null : String(next));
  }, []);
  return [width, change] as const;
}

/** The edge between the sidebar and the page: drag, arrow keys, double click to reset. */
export function SidebarResizer({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add('side-resizing');
    return () => document.body.classList.remove('side-resizing');
  }, [dragging]);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-controls="app-sidebar"
      aria-label={t('Menu width')}
      title={t('Drag to change the menu width, double-click to restore it')}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      className={`side-resizer ${dragging ? 'dragging' : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (start.current) onChange(start.current.width + e.clientX - start.current.x);
      }}
      onPointerUp={() => {
        start.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDragging(false);
      }}
      onDoubleClick={() => onChange(SIDEBAR_WIDTH.initial)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? WIDTH_STEP * 4 : WIDTH_STEP;
        if (e.key === 'ArrowLeft') onChange(width - step);
        else if (e.key === 'ArrowRight') onChange(width + step);
        else if (e.key === 'Home') onChange(SIDEBAR_WIDTH.min);
        else if (e.key === 'End') onChange(SIDEBAR_WIDTH.max);
        else return;
        e.preventDefault();
      }}
    />
  );
}

/** Label next to an icon of the collapsed sidebar, in a portal so the scrolling sidebar does not clip it. */
function Tip({ anchor, children }: { anchor: HTMLElement | null; children: ReactNode }) {
  if (!anchor) return null;
  const r = anchor.getBoundingClientRect();
  return createPortal(
    <motion.div role="tooltip" className="side-tip" style={{ top: r.top + r.height / 2, left: r.right + 10, y: '-50%' }} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.12 }}>
      {children}
    </motion.div>,
    document.body,
  );
}

export function pageLabel(page: NavPage, t: (k: string) => string) {
  if (!page.netbox) return t(page.label);
  return page.label === 'search' ? nbT('search') : typeLabel(page.label);
}

function SideLink({ page, label, active, rail, icon: IconC, onNavigate }: { page: { to: string }; label: string; active: boolean; rail?: boolean; icon: NavPage['icon']; onNavigate?: () => void }) {
  const compact = useCompact();
  const [tip, setTip] = useState<HTMLElement | null>(null);
  const show = (e: { currentTarget: HTMLElement }) => rail && !compact && setTip(e.currentTarget);
  const hide = () => setTip(null);
  useEffect(() => {
    if (!rail) setTip(null);
  }, [rail]);
  return (
    <Link
      to={page.to}
      className={`side-link ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
      aria-label={rail ? label : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={() => {
        hide();
        onNavigate?.();
      }}
    >
      {active && <motion.span layoutId="side-pill" className="side-pill" transition={spring} />}
      <IconC size={17} aria-hidden />
      <span className="side-label" title={rail ? undefined : label}>
        {label}
      </span>
      {rail && <Tip anchor={tip}>{label}</Tip>}
    </Link>
  );
}

function groupActive(g: NavGroup, path: string) {
  return g.tree === 'bases' ? basesOwn(path) : g.pages.some((p) => owns(p, path));
}

function GroupAccordion({ group, first, path, onNavigate }: { group: NavGroup; first: boolean; path: string; onNavigate?: () => void }) {
  const t = useT();
  const hasActive = groupActive(group, path);
  const [open, setOpen] = useState(() => {
    if (hasActive) return true;
    const v = read(openKey(group.id));
    return v === null ? first : v === '1';
  });
  useEffect(() => {
    if (hasActive) setOpen(true);
  }, [hasActive]);
  const toggle = () =>
    setOpen((v) => {
      write(openKey(group.id), v ? '0' : '1');
      return !v;
    });
  const Icon = group.icon;
  return (
    <div className="side-group">
      <button type="button" className={`side-accordion ${hasActive ? 'has-active' : ''}`} aria-expanded={open} onClick={toggle}>
        <Icon size={17} aria-hidden />
        <span>{t(group.title)}</span>
        <motion.span className="side-chevron" animate={{ rotate: open ? 180 : 0 }} transition={spring}>
          <ChevronDown size={16} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="side-children"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className={`side-children-inner ${group.tree ? 'side-tree' : ''}`}>
              {group.tree === 'bases' ? (
                <BasesTree />
              ) : (
                group.pages.map((p) => (
                  <Fragment key={p.id}>
                    {p.sub && <div className="side-sub">{nbT(p.sub)}</div>}
                    <SideLink page={p} label={pageLabel(p, t)} icon={p.icon} active={owns(p, path)} onNavigate={onNavigate} />
                  </Fragment>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The application sidebar (Umbrella Sidebar): groups as accordions, the active page marked by a
 * sliding pill; collapsed, it is a rail of page icons with tooltips.
 */
export function AppSidebar({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const t = useT();
  const { pathname: path } = useLocation();
  const groups = navGroups(!!useAuth().account?.admin);
  return (
    <nav id="app-sidebar" className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label={t('Sections')}>
      {collapsed
        ? groups.map((g, i) => (
            <Fragment key={g.id}>
              {i > 0 && <span className="side-sep" aria-hidden />}
              <div className="side-group" role="group" aria-label={t(g.title)}>
                {g.tree === 'bases' ? (
                  <SideLink page={{ to: '/' }} label={t('Bases')} icon={House} active={basesOwn(path)} rail />
                ) : (
                  g.pages.map((p) => <SideLink key={p.id} page={p} label={pageLabel(p, t)} icon={p.icon} active={owns(p, path)} rail />)
                )}
              </div>
            </Fragment>
          ))
        : groups.map((g, i) => <GroupAccordion key={g.id} group={g} first={i === 0} path={path} onNavigate={onNavigate} />)}
    </nav>
  );
}
