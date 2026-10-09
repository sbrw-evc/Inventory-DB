import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { BaseWithTables } from '../api/endpoints';
import { useBases } from '../api/hooks';
import { t } from '../i18n';
import { permissionsFor } from '../lib/roles';
import { Icon, ViewIcon } from './Icon';
import { Brand } from './shell/Brand';
import { UserMenu } from './shell/UserMenu';
import { Popover } from './Popover';

interface Hit {
  kind: 'base' | 'table' | 'view' | 'dcim';
  label: string;
  sub?: string;
  to: string;
  icon: React.ReactNode;
}

export function GlobalSearch() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const bases = useBases();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // "/" focuses the search from anywhere outside a text field, as in the Umbrella top bar tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== '/' || e.ctrlKey || e.metaKey || el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hits = useMemo<Hit[]>(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const out: Hit[] = [];
    for (const b of bases.data ?? []) {
      if (b.title.toLowerCase().includes(term)) out.push({ kind: 'base', label: b.title, to: `/base/${b.id}`, icon: <Icon name="database" size={14} /> });
      const full = qc.getQueryData<BaseWithTables>(['base', b.id]);
      for (const tb of full?.tables ?? []) {
        if (tb.title.toLowerCase().includes(term)) out.push({ kind: 'table', label: tb.title, sub: b.title, to: `/base/${b.id}/table/${tb.id}`, icon: <Icon name="table" size={14} /> });
        for (const v of tb.views ?? []) {
          if (v.title.toLowerCase().includes(term))
            out.push({ kind: 'view', label: v.title, sub: `${b.title} › ${tb.title}`, to: `/base/${b.id}/table/${tb.id}/view/${v.id}`, icon: <ViewIcon type={v.type} size={14} /> });
        }
      }
    }
    out.splice(30);
    // DCIM / IPAM objects are searched by the NetBox section's own search page.
    out.push({ kind: 'dcim', label: t('Search DCIM / IPAM for “{q}”', { q: q.trim() }), to: `/dcim/search?q=${encodeURIComponent(q.trim())}`, icon: <Icon name="search" size={14} /> });
    return out;
  }, [q, bases.data, qc]);

  const go = (h: Hit) => {
    navigate(h.to);
    setOpen(false);
    setQ('');
  };

  return (
    <div className="global-search" ref={ref}>
      <Search size={16} aria-hidden />
      <input
        ref={input}
        aria-label={t('Search bases, tables and views')}
        placeholder={t('Search bases, tables and views')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActiveIdx(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIdx((i) => Math.min(i + 1, hits.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && hits[activeIdx]) go(hits[activeIdx]);
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {!q && <kbd aria-hidden>/</kbd>}
      {open && q.trim() && (
        <Popover anchor={ref} onClose={() => setOpen(false)} matchWidth className="menu search-results">
          {hits.map((h, i) => (
            <button key={h.to} className={`menu-item ${i === activeIdx ? 'selected' : ''}`} onMouseEnter={() => setActiveIdx(i)} onClick={() => go(h)}>
              <span className="menu-item-icon">{h.icon}</span>
              <span className="menu-item-label">
                {h.label}
                {h.sub && <span className="muted small"> · {h.sub}</span>}
              </span>
              <span className="menu-item-hint">{t(h.kind)}</span>
            </button>
          ))}
          {!hits.length && <div className="empty-hint">{t('Nothing found. Open a base to search its tables.')}</div>}
        </Popover>
      )}
    </div>
  );
}

/** Top bar of the signed-in shell (Umbrella TopBar): menu toggle, brand, search, base role, user menu. */
export function TopBar({ sidebar }: { sidebar?: { collapsed: boolean; toggle: () => void } }) {
  const bases = useBases();
  const location = useLocation();
  const currentBaseId = /^\/base\/([^/]+)/.exec(location.pathname)?.[1];
  const currentRole = (bases.data ?? []).find((b) => b.id === currentBaseId)?.role;
  const label = t(sidebar?.collapsed ? 'Expand the menu' : 'Collapse the menu');
  return (
    <header className="topbar">
      <div className="topbar-start">
        {sidebar && (
          <button type="button" className="icon-btn side-toggle" aria-label={label} title={label} aria-expanded={!sidebar.collapsed} aria-controls="app-sidebar" onClick={sidebar.toggle}>
            {sidebar.collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        )}
        <Link to="/" className="brand-link" aria-label="Inventory DB">
          <Brand />
        </Link>
      </div>
      <div className="topbar-end">
        <GlobalSearch />
        {currentRole && (
          <span className="header-role" title={t('Your role in this base')}>
            {t(permissionsFor(currentRole).role)}
          </span>
        )}
        <UserMenu />
      </div>
    </header>
  );
}

/** Kept for callers of the old name. */
export const AppHeader = TopBar;
