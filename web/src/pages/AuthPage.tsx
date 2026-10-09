import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { Brand, Preferences } from '../components/shell/Brand';
import { t } from '../i18n';
import { useAuth } from '../lib/auth';

export function AuthPage({ mode }: { mode: 'signin' | 'signup' }) {
  const { token, signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [shown, setShown] = useState(false);
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
    <div className="center-page">
      <motion.div className="card signin" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
        <div className="signin-top">
          <Brand />
          <Preferences />
        </div>
        <form onSubmit={submit} noValidate={false}>
          <div>
            <h1>{mode === 'signin' ? t('Sign in') : t('Create your account')}</h1>
            <p className="muted" style={{ marginTop: 6 }}>{t('Spreadsheet-style database for your inventory.')}</p>
          </div>
          {error && (
            <div className="notice notice-error" role="alert">
              <b>{error}</b>
            </div>
          )}
          {mode === 'signup' && (
            <div className="field">
              <label className="field-label" htmlFor="auth-name">{t('Name')}</label>
              <input id="auth-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </div>
          )}
          <div className="field">
            <label className="field-label" htmlFor="auth-email">{t('Email')}</label>
            <input id="auth-email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="auth-password">{t('Password')}</label>
            <div className="password">
              <input
                id="auth-password"
                className="input"
                type={shown ? 'text' : 'password'}
                required
                minLength={mode === 'signup' ? 8 : 1}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              />
              <button type="button" className="icon-btn" onClick={() => setShown(!shown)} aria-label={shown ? t('Hide') : t('Show')}>
                {shown ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {mode === 'signup' && <div className="hint">{t('At least 8 characters.')}</div>}
          </div>
          <button className="btn btn-primary btn-block" disabled={busy || !email || !password}>
            {busy && <LoaderCircle className="spin" size={16} aria-hidden />}
            {mode === 'signin' ? t('Sign in') : t('Sign up')}
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
      </motion.div>
      <p className="hint">Inventory DB</p>
    </div>
  );
}
