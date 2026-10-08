import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { BaseWithTables } from '../api/endpoints';
import { useBases } from '../api/hooks';
import { LANGS, setLang, t, useLang } from '../i18n';
import { useAuth } from '../lib/auth';
import { permissionsFor } from '../lib/roles';
import { Icon, ViewIcon } from './Icon';
import { Popover } from './Popover';

interface Hit {
  kind: 'base' | 'table' | 'view';
  label: string;
  sub?: string;
  to: string;
  icon: React.ReactNode;
}

function GlobalSearch() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const bases = useBases();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

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
    return out.slice(0, 30);
  }, [q, bases.data, qc]);

  const go = (h: Hit) => {
    navigate(h.to);
    setOpen(false);
    setQ('');
  };

  return (
    <div className="global-search" ref={ref}>
      <Icon name="search" size={14} />
      <input
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

function UserMenu() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} className="header-user" onClick={() => setOpen((o) => !o)}>
        <span className="avatar avatar-sm">{(user?.name || user?.email || '?').slice(0, 1).toUpperCase()}</span>
        <span className="header-user-name">{user?.name || user?.email}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <Popover anchor={ref} onClose={() => setOpen(false)} align="end" className="menu">
          <div className="menu-title">
            {user?.name}
            <div className="muted small">{user?.email}</div>
          </div>
          <button className="menu-item" onClick={() => { setOpen(false); navigate('/admin/tokens'); }}>
            <span className="menu-item-icon"><Icon name="key" /></span>
            <span className="menu-item-label">{t('API tokens')}</span>
          </button>
          <div className="menu-divider" />
          <div className="menu-title small">{t('Language')}</div>
          {LANGS.map((l) => (
            <button key={l.code} className={`menu-item ${lang === l.code ? 'selected' : ''}`} onClick={() => { setLang(l.code); setOpen(false); }}>
              <span className="menu-item-icon">{lang === l.code && <Icon name="check" />}</span>
              <span className="menu-item-label">{l.label}</span>
            </button>
          ))}
          <div className="menu-divider" />
          <button className="menu-item danger" onClick={() => { setOpen(false); signOut(); }}>
            <span className="menu-item-icon"><Icon name="logout" /></span>
            <span className="menu-item-label">{t('Sign out')}</span>
          </button>
        </Popover>
      )}
    </>
  );
}

/** Umbrella-style dark navy header: product, sections, global search, user menu. */
export function AppHeader() {
  const bases = useBases();
  const location = useLocation();
  const currentBaseId = /^\/base\/([^/]+)/.exec(location.pathname)?.[1];
  const currentRole = (bases.data ?? []).find((b) => b.id === currentBaseId)?.role;
  const sections = [
    { to: '/', label: 'Bases', end: false, match: (p: string) => p === '/' || p.startsWith('/base') },
    { to: '/dcim', label: 'DCIM' },
    { to: '/ipam', label: 'IPAM' },
    { to: '/integrations', label: 'Integrations' },
    { to: '/admin', label: 'Administration' },
  ];
  return (
    <header className="app-header">
      <NavLink to="/" className="brand">
        <Icon name="database" size={18} />
        <span>Inventory DB</span>
      </NavLink>
      <nav className="header-nav">
        {sections.map((s) => (
          <NavLink
            key={s.to}
            to={s.to}
            end={s.to === '/' ? false : undefined}
            className={({ isActive }) => {
              const active = s.match ? s.match(location.pathname) : isActive;
              return `header-link ${active ? 'active' : ''}`;
            }}
          >
            {t(s.label)}
          </NavLink>
        ))}
      </nav>
      <GlobalSearch />
      <span className="spacer" />
      {currentRole && <span className="header-role" title={t('Your role in this base')}>{t(permissionsFor(currentRole).role)}</span>}
      <UserMenu />
    </header>
  );
}
