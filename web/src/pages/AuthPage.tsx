import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { LANGS, setLang, t, useLang } from '../i18n';
import { useAuth } from '../lib/auth';

export function AuthPage({ mode }: { mode: 'signin' | 'signup' }) {
  const { token, signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const lang = useLang();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  if (token) return <Navigate to={from} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signin') await signIn(email.trim(), password);
      else await signUp(email.trim(), password, name.trim() || undefined);
      navigate(from, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <header className="app-header">
        <span className="brand">
          <Icon name="database" size={18} />
          <span>Inventory DB</span>
        </span>
        <span className="spacer" />
        <select className="lang-select" value={lang} onChange={(e) => setLang(e.target.value as typeof lang)} aria-label={t('Language')}>
          {LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </header>
      <div className="auth-center">
        <form className="auth-card" onSubmit={submit}>
          <h1>{mode === 'signin' ? t('Sign in') : t('Create your account')}</h1>
          <p className="muted">{t('Spreadsheet-style database for your inventory.')}</p>
          {mode === 'signup' && (
            <>
              <label className="field-label">{t('Name')}</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </>
          )}
          <label className="field-label">{t('Email')}</label>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
          <label className="field-label">{t('Password')}</label>
          <input
            className="input"
            type="password"
            required
            minLength={mode === 'signup' ? 8 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          />
          {mode === 'signup' && <div className="muted small">{t('At least 8 characters.')}</div>}
          {error && <div className="notice notice-error">{error}</div>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? t('Please wait…') : mode === 'signin' ? t('Sign in') : t('Sign up')}
          </button>
          <div className="auth-switch">
            {mode === 'signin' ? (
              <>
                {t('No account yet?')} <Link to="/signup" state={location.state}>{t('Sign up')}</Link>
              </>
            ) : (
              <>
                {t('Already have an account?')} <Link to="/signin" state={location.state}>{t('Sign in')}</Link>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
