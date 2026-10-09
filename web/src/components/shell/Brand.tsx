import { useId, type ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { setLang, useLang, useT, type Lang } from '../../i18n';
import { originOf, setTheme, useTheme } from '../../lib/theme';

/** The spring Umbrella uses for pills, chevrons and dialogs. */
export const spring: Transition = { type: 'spring', stiffness: 420, damping: 30 };

export function Brand({ subtitle, compact }: { subtitle?: string; compact?: boolean }) {
  return (
    <span className="brand">
      <img src="/logo.svg" alt="" width={32} height={32} />
      {!compact && (
        <span>
          <span className="brand-name">Inventory DB</span>
          {subtitle && <span className="brand-sub">{subtitle}</span>}
        </span>
      )}
    </span>
  );
}

/** Segmented control with a sliding pill (Umbrella ui.tsx Segmented). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  const group = useId();
  return (
    <div className="segmented has-pill" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {value === o.value && <motion.span layoutId={`seg-${group}`} className="seg-pill" transition={spring} />}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function ThemeToggle() {
  const t = useT();
  const theme = useTheme();
  return (
    <button type="button" className="icon-btn" aria-label={t('Switch theme')} title={t('Switch theme')} onClick={(e) => setTheme(theme === 'dark' ? 'light' : 'dark', originOf(e))}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={theme}
          style={{ display: 'inline-flex' }}
          initial={{ rotate: -90, scale: 0.4, opacity: 0 }}
          animate={{ rotate: 0, scale: 1, opacity: 1 }}
          exit={{ rotate: 90, scale: 0.4, opacity: 0 }}
          transition={{ duration: 0.22 }}
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

/** Language (EN / RU) and theme switches of the sign-in and public pages (Umbrella Preferences). */
export function Preferences() {
  const t = useT();
  const lang = useLang();
  return (
    <div className="prefs">
      <Segmented<Lang>
        label={t('Language')}
        value={lang}
        onChange={setLang}
        options={[
          { value: 'en', label: 'EN' },
          { value: 'ru', label: 'RU' },
        ]}
      />
      <ThemeToggle />
    </div>
  );
}
