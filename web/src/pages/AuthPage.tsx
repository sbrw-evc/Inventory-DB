import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { checkPassword } from '@shared';
import { ApiRequestError } from '../api/client';
import { authApi, type AuthProviders } from '../api/endpoints';
import { Brand, Preferences } from '../components/shell/Brand';
import { t } from '../i18n';
import { useAuth } from '../lib/auth';
import { ChangePasswordForm } from '../settings/ChangePassword';
import { PolicyChecklist } from '../settings/policy';

/** Same-site paths only, like the server's return check. */
const safePath = (p: string | null | undefined) => (p && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\') ? p : '/');

function MicrosoftLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export function AuthPage({ mode }: { mode: 'signin' | 'signup' }) {
  const { token, signIn, signUp, adoptSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [shown, setShown] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [ssoReturn, setSsoReturn] = useState<string | null>(null);
  const from = ssoReturn ?? (location.state as { from?: string } | null)?.from ?? '/';

  useEffect(() => {
    authApi.providers().then(setProviders, () => setProviders(null));
  }, []);

  // Entra ID sign-in comes back as /signin#sso_token=…&return=… or /signin?sso_error=…
  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const sso = hash.get('sso_token');
    const failed = new URLSearchParams(location.search).get('sso_error');
    if (!sso && !failed) return;
    window.history.replaceState(null, '', window.location.pathname);
    if (failed) setError(t(failed));
    if (sso) {
      setSsoReturn(safePath(hash.get('return')));
      adoptSession(sso);
    }
  }, [location.search, adoptSession]);

  if (token) return <Navigate to={from} replace />;

  const policy = providers?.password_policy;
  const signupBlocked = mode === 'signup' && !!policy && checkPassword(password, email.trim(), policy).length > 0;
  const ldap = mode === 'signin' && !!providers?.ldap;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signin') await signIn(email.trim(), password);
      else await signUp(email.trim(), password, name.trim() || undefined);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'PASSWORD_EXPIRED') setExpired(true);
      else setError(err instanceof ApiRequestError ? t(err.message) : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const card = (body: ReactNode) => (
    <div className="center-page">
      <motion.div className="card signin" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
        <div className="signin-top">
          <Brand />
          <Preferences />
        </div>
        {body}
      </motion.div>
      <p className="hint">Inventory DB</p>
    </div>
  );

  if (expired)
    return card(
      <div className="stack" style={{ gap: 16 }}>
        <div>
          <h1>{t('Your password has expired')}</h1>
          <p className="muted" style={{ marginTop: 6 }}>{t('Choose a new password to continue.')}</p>
        </div>
        <ChangePasswordForm
          login={email.trim()}
          current={password}
          onDone={() => navigate(from, { replace: true })}
          onCancel={() => {
            setExpired(false);
            setPassword('');
          }}
        />
      </div>,
    );

  return card(
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
      {mode === 'signin' && providers?.entra && (
        <>
          <a className="btn btn-block" href={`/api/v1/auth/entra/start?return=${encodeURIComponent(safePath(from))}`}>
            <MicrosoftLogo />
            {t('Sign in with Microsoft')}
          </a>
          <div className="auth-or">
            <span>{t('or')}</span>
          </div>
        </>
      )}
      {mode === 'signup' && (
        <div className="field">
          <label className="field-label" htmlFor="auth-name">{t('Name')}</label>
          <input id="auth-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </div>
      )}
      <div className="field">
        <label className="field-label" htmlFor="auth-email">{ldap ? t('Email or user name') : t('Email')}</label>
        <input
          id="auth-email"
          className="input"
          type={ldap ? 'text' : 'email'}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete={ldap ? 'username' : 'email'}
          autoFocus
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="auth-password">{t('Password')}</label>
        <div className="password">
          <input
            id="auth-password"
            className="input"
            type={shown ? 'text' : 'password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          />
          <button type="button" className="icon-btn" onClick={() => setShown(!shown)} aria-label={shown ? t('Hide') : t('Show')}>
            {shown ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        {mode === 'signup' && policy && (
          <div style={{ marginTop: 8 }}>
            <PolicyChecklist policy={policy} password={password} login={email.trim()} />
          </div>
        )}
      </div>
      <button className="btn btn-primary btn-block" disabled={busy || !email || !password || signupBlocked}>
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
    </form>,
  );
}
