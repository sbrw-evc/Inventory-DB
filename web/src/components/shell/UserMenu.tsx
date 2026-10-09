import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, KeyRound, Languages, LogOut, Moon, Sun } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LANGS, setLang, useLang, useT } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { setTheme, useTheme, type Theme } from '../../lib/theme';
import { spring } from './Brand';

const AVATAR_COLORS = ['#65a30d', '#ca8a04', '#0d9488', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a'];

export function initialsOf(name: string) {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Initials on a colour picked from the name, like Umbrella's Avatar without a photo. */
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: AVATAR_COLORS[h % AVATAR_COLORS.length] }} aria-hidden>
      {initialsOf(name)}
    </span>
  );
}

/** The user menu of the top bar (Umbrella UserMenu): account, language and theme accordions, sign out. */
export function UserMenu({ compact }: { compact?: boolean }) {
  const t = useT();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<'language' | 'theme' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const name = user?.name || user?.email || '?';

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) setSection(null);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>('button')?.focus());
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const origin = () => {
    const r = trigger.current?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined;
  };

  return (
    <div className="user-menu" ref={root}>
      <button ref={trigger} type="button" className="user-btn" aria-haspopup="menu" aria-expanded={open} aria-controls={id} aria-label={t('Account menu')} onClick={() => setOpen((v) => !v)}>
        {!compact && (
          <span className="who">
            <strong>{user?.name || user?.email}</strong>
            {user?.name && <small>{user.email}</small>}
          </span>
        )}
        <Avatar name={name} />
        {!compact && (
          <motion.span className="chevron" animate={{ rotate: open ? 180 : 0 }} transition={spring}>
            <ChevronDown size={16} />
          </motion.span>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={menu}
            id={id}
            role="menu"
            className="user-dropdown"
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            style={{ transformOrigin: 'top right' }}
          >
            <div className="menu-head">
              <Avatar name={name} size={44} />
              <div>
                <strong>{user?.name || user?.email}</strong>
                {user?.name && <small>{user.email}</small>}
              </div>
            </div>
            <button type="button" role="menuitem" className="um-item" onClick={() => navigate('/admin/tokens')}>
              <KeyRound size={18} />
              {t('API tokens')}
            </button>
            <Accordion
              icon={<Languages size={18} />}
              label={t('Language')}
              value={LANGS.find((l) => l.code === lang)?.label ?? lang}
              open={section === 'language'}
              onToggle={() => setSection(section === 'language' ? null : 'language')}
              options={LANGS.map((l) => ({ key: l.code, label: l.label, selected: l.code === lang, select: () => setLang(l.code) }))}
            />
            <Accordion
              icon={theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
              label={t('Theme')}
              value={t(theme === 'dark' ? 'Dark' : 'Light')}
              open={section === 'theme'}
              onToggle={() => setSection(section === 'theme' ? null : 'theme')}
              options={(['light', 'dark'] as Theme[]).map((v) => ({
                key: v,
                label: t(v === 'dark' ? 'Dark' : 'Light'),
                icon: v === 'dark' ? <Moon size={16} /> : <Sun size={16} />,
                selected: v === theme,
                select: () => setTheme(v, origin()),
              }))}
            />
            <div className="um-sep" />
            <button type="button" role="menuitem" className="um-item danger" onClick={signOut}>
              <LogOut size={18} />
              {t('Sign out')}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type Option = { key: string; label: string; icon?: ReactNode; selected: boolean; select: () => void };

function Accordion({ icon, label, value, open, onToggle, options }: { icon: ReactNode; label: string; value: string; open: boolean; onToggle: () => void; options: Option[] }) {
  const panel = useId();
  return (
    <div className={`um-accordion ${open ? 'open' : ''}`}>
      <button type="button" className="um-item" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        {icon}
        <span className="um-label">{label}</span>
        <span className="um-value">{value}</span>
        <motion.span className="um-chevron" animate={{ rotate: open ? 90 : 0 }} transition={spring}>
          <ChevronRight size={16} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panel}
            role="group"
            aria-label={label}
            className="um-options"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            {options.map((o) => (
              <button key={o.key} type="button" role="menuitemradio" aria-checked={o.selected} className={`um-option ${o.selected ? 'selected' : ''}`} onClick={o.select}>
                {o.icon}
                <span className="um-label">{o.label}</span>
                {o.selected && (
                  <motion.span style={{ display: 'inline-flex' }} initial={{ scale: 0.3 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 520, damping: 18 }}>
                    <Check size={16} />
                  </motion.span>
                )}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
