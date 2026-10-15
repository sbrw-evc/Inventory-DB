import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { LoaderCircle, LogIn, ShieldAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { authApi, spaUrls, type SpaStatus } from '../api/endpoints';
import { Brand, Preferences } from '../components/shell/Brand';
import { t } from '../i18n';
import { takeSignedOut, useAuth } from '../lib/auth';

/** Same-site paths only, like the server's return check. */
const safePath = (p: string | null | undefined) => (p && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\') ? p : '/');

const SPA_REPO = 'https://github.com/sbrw-evc/SPA-Single-point-of-authorization-';

/**
 * Sign-in: Inventory DB keeps no passwords — people sign in with SPA (Single Point of Authorization). Without a session
 * the page goes to SPA by itself, unless the person has just signed out or SPA sent back an error.
 */
export function AuthPage() {
  const { token, adoptSession } = useAuth();
  const location = useLocation();
  const [status, setStatus] = useState<SpaStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ssoReturn, setSsoReturn] = useState<string | null>(null);
  const [stay] = useState(() => takeSignedOut() || new URLSearchParams(location.search).has('signed_out'));
  const from = safePath(ssoReturn ?? (location.state as { from?: string } | null)?.from ?? '/');

  // SPA's answer: /signin#sso_token=…&return=… or /signin?sso_error=…
  const [hash] = useState(() => new URLSearchParams(window.location.hash.slice(1)));
  const [ssoError] = useState(() => new URLSearchParams(location.search).get('sso_error'));
  useEffect(() => {
    const sso = hash.get('sso_token');
    if (!sso && !ssoError && !location.search.includes('signed_out')) return;
    window.history.replaceState(null, '', window.location.pathname);
    if (ssoError) setError(t(ssoError));
    if (sso) {
      setSsoReturn(safePath(hash.get('return')));
      adoptSession(sso);
    }
  }, [hash, ssoError, location.search, adoptSession]);

  useEffect(() => {
    if (token || hash.get('sso_token')) return;
    authApi.spa().then(setStatus, () => setFailed(true));
  }, [token, hash]);

  const auto = !!status?.connected && !ssoError && !stay && !hash.get('sso_token');
  useEffect(() => {
    if (auto) window.location.assign(spaUrls.start(from));
  }, [auto, from]);

  if (token) return <Navigate to={from} replace />;

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

  const head = (
    <div>
      <h1>{t('Sign in')}</h1>
      <p className="muted" style={{ marginTop: 6 }}>{t('Spreadsheet-style database for your inventory.')}</p>
    </div>
  );

  if (failed)
    return card(
      <div className="stack" style={{ gap: 16 }}>
        {head}
        <div className="notice notice-error" role="alert">
          <b>{t('Inventory DB did not answer. Try again later.')}</b>
        </div>
        <button type="button" className="btn btn-block" onClick={() => window.location.reload()}>
          {t('Try again')}
        </button>
      </div>,
    );

  if (!status || auto)
    return card(
      <div className="stack" style={{ gap: 16 }}>
        {head}
        <p className="muted auth-redirect" role="status">
          <LoaderCircle className="spin" size={16} aria-hidden /> {status ? t('Opening SPA…') : t('Loading…')}
        </p>
      </div>,
    );

  if (!status.connected)
    return card(
      <div className="stack" style={{ gap: 16 }}>
        {head}
        <div className="notice notice-warning" role="alert">
          <ShieldAlert size={16} aria-hidden />
          <b>{t('This application is not connected to SPA')}</b>
        </div>
        <div className="auth-help">
          <p>{t('Sign-in and access to Inventory DB are managed in SPA (Single Point of Authorization). To connect:')}</p>
          <ol>
            <li>{t('In SPA, open Applications → Connect an application, choose the type Inventory DB and enter the address of Inventory DB.')}</li>
            <li>{t('Give the Inventory DB roles (Administrator, Editor, Viewer) to people or groups.')}</li>
            <li>
              {t('Copy the connection key (spa1.…) and give it to Inventory DB in the environment variable')} <code>SPA_CONNECTION_KEY</code>{' '}
              {t('(or the file named by SPA_CONNECTION_KEY_FILE, or the secret spa / connection_key in OpenBao), then restart it.')}
            </li>
          </ol>
          <p>
            <a href={`${SPA_REPO}/blob/main/docs/protocol.md`} target="_blank" rel="noreferrer">
              {t('How applications connect to SPA')}
            </a>
          </p>
        </div>
      </div>,
    );

  return card(
    <div className="stack" style={{ gap: 16 }}>
      {head}
      {error && (
        <div className="notice notice-error" role="alert">
          <b>{error}</b>
        </div>
      )}
      {stay && !error && <p className="muted">{t('You have signed out.')}</p>}
      <a className="btn btn-primary btn-block" href={spaUrls.start(from, error || stay ? { prompt: 'login' } : {})}>
        <LogIn size={16} aria-hidden />
        {t('Sign in with SPA')}
      </a>
      <p className="hint auth-hint">
        {t('Passwords, passkeys and directory sign-in are handled by SPA.')}
      </p>
    </div>,
  );
}
