import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { ApiRequestError } from '../api/client';
import { t } from '../i18n';
import type { State } from './api';
import './settings.css';

/** Rounded card with a title row (Umbrella ProfileCard / status card); a form when `onSubmit` is given. */
export function Card({
  title,
  badge,
  footer,
  onSubmit,
  wide,
  children,
}: {
  title: ReactNode;
  badge?: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => void;
  wide?: boolean;
  children?: ReactNode;
}) {
  const body = (
    <>
      <header>
        <h2>{title}</h2>
        {badge}
      </header>
      {children}
      {footer && <div className="card-actions">{footer}</div>}
    </>
  );
  const className = `card status-card${wide ? ' span-all' : ''}`;
  if (!onSubmit) return <section className={className}>{body}</section>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <form className={className} onSubmit={submit} noValidate>
      {body}
    </form>
  );
}

/** Label / value rows; empty values are left out (Umbrella Rows). */
export function Rows({ rows, align = 'start' }: { rows: [ReactNode, ReactNode][]; align?: 'start' | 'end' }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false);
  if (!shown.length) return null;
  return (
    <dl className={`rows${align === 'end' ? ' rows-end' : ''}`}>
      {shown.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pill({ state, label }: { state: State; label?: string }) {
  const text = label ?? { ok: t('Works'), warn: t('Attention'), error: t('Error'), off: t('Off') }[state];
  return <span className={`pill pill-${state}`}>{text}</span>;
}

export function Banner({ kind, title, children }: { kind: 'info' | 'warn' | 'error' | 'ok'; title: ReactNode; children?: ReactNode }) {
  const cls = { info: '', warn: 'notice-warning', error: 'notice-error', ok: 'notice-success' }[kind];
  return (
    <div className={`notice ${cls}`} role={kind === 'error' ? 'alert' : undefined}>
      <b>{title}</b>
      {children && <div className="notice-body">{children}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="switch-row">
      <label className="switch">
        <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="switch-track" />
      </label>
      <label htmlFor={id} className="switch-text">
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </label>
    </div>
  );
}

export function Field({ label, hint, optional, children }: { label: ReactNode; hint?: ReactNode; optional?: boolean; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {optional && <span className="field-optional"> · {t('optional')}</span>}
      </label>
      {children(id)}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Password({ id, value, onChange, autoComplete = 'new-password', placeholder }: { id?: string; value: string; onChange: (v: string) => void; autoComplete?: string; placeholder?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password">
      <input id={id} className="input" type={shown ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} placeholder={placeholder} spellCheck={false} />
      <button type="button" className="icon-btn" onClick={() => setShown(!shown)} aria-label={shown ? t('Hide') : t('Show')}>
        {shown ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

export function Button({
  children,
  onClick,
  busy,
  disabled,
  variant,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
  type?: 'button' | 'submit';
}) {
  return (
    <button type={type} className={`btn${variant ? ` btn-${variant}` : ''}`} onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy && <LoaderCircle className="spin" size={16} aria-hidden />}
      {children}
    </button>
  );
}

export type ErrorText = { message: string; detail?: string };

/** Readable text of an API error; known codes get a translated message. */
export function errorText(e: unknown): ErrorText {
  if (e instanceof ApiRequestError) {
    if (e.status === 403 && e.code === 'FORBIDDEN') return { message: t('Only administrators can open the settings.') };
    return { message: t(e.message) };
  }
  return { message: e instanceof Error ? e.message : String(e) };
}

/** A running request: busy flag, error, and a success notice that fades out. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorText | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (alive.current && msg) setNotice(msg);
      return true;
    } catch (e) {
      if (alive.current) setError(errorText(e));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);
  const clear = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);
  return { busy, error, notice, run, clear };
}

export type Action = ReturnType<typeof useAction>;

export function ActionResult({ action }: { action: Action }) {
  return (
    <>
      {action.notice && <Banner kind="ok" title={action.notice} />}
      {action.error && (
        <Banner kind="error" title={action.error.message}>
          {action.error.detail}
        </Banner>
      )}
    </>
  );
}

/** Loads `load()` and reloads on `reload()` or when `epoch` changes. */
export function useResource<T>(load: () => Promise<T>, epoch = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ErrorText | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let live = true;
    setBusy(true);
    loader
      .current()
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e) => live && setError(errorText(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [epoch, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, busy, reload, setData };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function formatBytes(n: number | undefined, locale: string) {
  if (n === undefined || n === null) return '';
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(locale, { maximumFractionDigits: i === 0 ? 0 : 1 })} ${t(UNITS[i])}`;
}

export function formatMs(ms: number, locale: string) {
  if (ms < 1000) return `${ms.toLocaleString(locale, { maximumFractionDigits: 1 })} ${t('ms')}`;
  const s = ms / 1000;
  if (s < 120) return `${s.toLocaleString(locale, { maximumFractionDigits: 1 })} ${t('s')}`;
  const m = s / 60;
  if (m < 120) return `${m.toLocaleString(locale, { maximumFractionDigits: 1 })} ${t('min')}`;
  return `${(m / 60).toLocaleString(locale, { maximumFractionDigits: 1 })} ${t('h')}`;
}

export function formatPercent(part: number, total: number, locale: string) {
  if (!total) return '—';
  return `${((part / total) * 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %`;
}

export function formatDuration(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d} ${t('d')}`);
  if (d || h) parts.push(`${h} ${t('h')}`);
  if (!d) parts.push(`${m} ${t('min')}`);
  if (!d && !h) parts.push(`${Math.floor(sec % 60)} ${t('s')}`);
  return parts.join(' ');
}

/** Compact data table (PostgreSQL statistics, secret list). */
export function Table({ columns, rows }: { columns: { label: string; numeric?: boolean; wide?: boolean }[]; rows: { key: string | number; cells: ReactNode[] }[] }) {
  return (
    <div className="settings-table">
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} className={c.numeric ? 'num' : c.wide ? 'wide' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((cell, i) => (
                <td key={i} className={columns[i].numeric ? 'num' : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
