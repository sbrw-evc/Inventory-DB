import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Fingerprint, KeyRound, LoaderCircle, Umbrella } from 'lucide-react';
import { motion } from 'motion/react';
import { checkPassword } from '@shared';
import { ApiRequestError } from '../api/client';
import { authApi, type AuthMethods, type AuthProviders } from '../api/endpoints';
import { Brand, Preferences } from '../components/shell/Brand';
import { t } from '../i18n';
import { useAuth } from '../lib/auth';
import { ChangePasswordForm } from '../settings/ChangePassword';
import { PolicyChecklist } from '../settings/policy';
import { PasskeyError, passkeysSupported } from '../lib/webauthn';

/** Same-site paths only, like the server's return check. */
const safePath = (p: string | null | undefined) => (p && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\') ? p : '/');

function GoogleLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function AppleLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M16.37 12.6c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.82-.81-3-.79-1.54.02-2.96.9-3.76 2.28-1.6 2.78-.41 6.9 1.15 9.16.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.99.72 1.24-.02 2.02-1.12 2.77-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.4-.92-2.42-3.66zM14.1 5.86c.63-.77 1.06-1.84.94-2.91-.91.04-2.02.61-2.67 1.37-.58.67-1.1 1.76-.96 2.8 1.02.08 2.06-.52 2.69-1.26z" />
    </svg>
  );
}

const providerLogo = (id: string) => (id === 'google' ? <GoogleLogo /> : id === 'apple' ? <AppleLogo /> : <KeyRound size={16} aria-hidden />);

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
  const { token, signIn, signUp, signInWithPasskey, adoptSession } = useAuth();
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
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [ssoReturn, setSsoReturn] = useState<string | null>(null);
  const from = ssoReturn ?? (location.state as { from?: string } | null)?.from ?? '/';

  useEffect(() => {
    authApi.providers().then(setProviders, () => setProviders(null));
    authApi.methods().then(setMethods, () => setMethods(null));
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

  const passkey = async () => {
    setPasskeyBusy(true);
    setError(null);
    try {
      await signInWithPasskey();
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof PasskeyError) setError(err.code === 'passkey_cancelled' ? t('The passkey request was cancelled or timed out.') : t('This browser cannot use passkeys.'));
      else setError(err instanceof ApiRequestError ? t(err.message) : (err as Error).message);
    } finally {
      setPasskeyBusy(false);
    }
  };
  const ret = `return=${encodeURIComponent(safePath(from))}`;
  const umbrella = mode === 'signin' ? methods?.umbrella : null;
  const external = mode === 'signin' ? (methods?.providers ?? []) : [];
  const showPasskey = mode === 'signin' && !!methods?.passkeys && passkeysSupported();
  const hasMethods = !!umbrella || external.length > 0 || showPasskey || (mode === 'signin' && !!providers?.entra);

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
      {mode === 'signin' && hasMethods && (
        <>
          <div className="auth-methods">
            {umbrella && (
              <a className="btn btn-block btn-umbrella" href={`/api/v1/auth/umbrella/start?${ret}`}>
                <Umbrella size={16} aria-hidden />
                {t('Sign in with Umbrella')}
              </a>
            )}
            {umbrella && umbrella.methods.filter((m) => m.id !== 'local').length > 0 && (
              <div className="auth-hub-methods" aria-label={t('Umbrella sign-in methods')}>
                {umbrella.methods
                  .filter((m) => m.id !== 'local')
                  .map((m) => (
                    <a key={m.id} className="btn btn-sm" href={`/api/v1/auth/umbrella/start?method=${encodeURIComponent(m.id)}&${ret}`}>
                      {m.id === 'passkey' ? <Fingerprint size={14} aria-hidden /> : null}
                      {m.id === 'passkey' ? t('Passkey') : m.title}
                    </a>
                  ))}
              </div>
            )}
            {showPasskey && (
              <button type="button" className="btn btn-block" onClick={passkey} disabled={passkeyBusy}>
                {passkeyBusy ? <LoaderCircle className="spin" size={16} aria-hidden /> : <Fingerprint size={16} aria-hidden />}
                {t('Sign in with a passkey')}
              </button>
            )}
            {providers?.entra && (
              <a className="btn btn-block" href={`/api/v1/auth/entra/start?${ret}`}>
                <MicrosoftLogo />
                {t('Sign in with Microsoft')}
              </a>
            )}
            {external.map((p) => (
              <a key={p.id} className="btn btn-block" href={`/api/v1/auth/sso/${p.id}/start?${ret}`}>
                {providerLogo(p.id)}
                {t('Sign in with {name}', { name: p.title })}
              </a>
            ))}
            {showPasskey && <p className="hint auth-hint">{t('A passkey is Windows Hello, Touch ID, Face ID, an Android fingerprint or a security key.')}</p>}
          </div>
          <div className="auth-or">
            <span>{t('or with a password')}</span>
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
