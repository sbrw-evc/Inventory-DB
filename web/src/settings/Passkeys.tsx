import { Fingerprint, KeyRound, Pencil, Smartphone, Trash2, Usb } from 'lucide-react';
import { ApiRequestError } from '../api/client';
import { authApi, type Passkey } from '../api/endpoints';
import { confirmDialog, promptDialog } from '../components/dialogs';
import { Modal } from '../components/Modal';
import { t } from '../i18n';
import { useAuth } from '../lib/auth';
import { formatDate } from '../lib/format';
import { createPasskey, PasskeyError, passkeysSupported } from '../lib/webauthn';
import { ActionResult, Banner, Button, useAction, useResource } from './ui';

function PasskeyIcon({ p }: { p: Passkey }) {
  if (p.transports.some((x) => ['usb', 'nfc', 'ble'].includes(x))) return <Usb size={18} />;
  if (p.transports.includes('hybrid')) return <Smartphone size={18} />;
  if (p.transports.includes('internal')) return <Fingerprint size={18} />;
  return <KeyRound size={18} />;
}

export function passkeyErrorText(e: unknown): Error {
  if (e instanceof PasskeyError)
    return new Error(e.code === 'passkey_cancelled' ? t('The passkey request was cancelled or timed out.') : t('This browser cannot use passkeys.'));
  if (e instanceof ApiRequestError) return new Error(t(e.message));
  return e as Error;
}

/**
 * The user's passkeys: Windows Hello (face, fingerprint, PIN), Touch ID / Face ID, Android biometrics and security
 * keys. Passkeys synchronised from Umbrella Monitoring are listed but managed in the Umbrella profile.
 */
export function PasskeysPanel() {
  const { account } = useAuth();
  const list = useResource(authApi.myPasskeys);
  const action = useAction();
  const fromHub = !!account?.passkeysFromHub;

  const add = () =>
    action.run(async () => {
      try {
        const c = await authApi.addPasskeyBegin();
        await authApi.addPasskeyFinish(c.ceremony, await createPasskey(c.options));
      } catch (e) {
        throw passkeyErrorText(e);
      }
      list.reload();
      return t('The passkey is added. Next time sign in with it — no password needed.');
    });
  const rename = async (p: Passkey) => {
    const name = await promptDialog({ title: t('Rename passkey'), label: t('Name'), initial: p.name, confirmLabel: t('Save') });
    if (name === null || !name.trim()) return;
    await action.run(async () => {
      await authApi.renamePasskey(p.id, name.trim());
      list.reload();
    });
  };
  const remove = async (p: Passkey) => {
    if (!(await confirmDialog({ title: t('Remove passkey “{name}”?', { name: p.name }), message: t('You will no longer be able to sign in with it.'), confirmLabel: t('Remove'), danger: true })))
      return;
    await action.run(async () => {
      await authApi.removePasskey(p.id);
      list.reload();
    });
  };

  if (!account?.passkeys) return <Banner kind="info" title={t('Passkeys are turned off. An administrator turns them on in Settings → Single sign-in.')} />;
  const items = list.data ?? [];
  return (
    <div className="stack" style={{ gap: 12 }}>
      <p className="muted">{t('Sign in with your face, fingerprint, screen lock PIN or a security key instead of a password. The passkey stays on your device.')}</p>
      {fromHub && account.hub && (
        <Banner kind="info" title={t('Your passkeys come from Umbrella Monitoring.')}>
          <a href={`${account.hub}/profile`} target="_blank" rel="noreferrer">
            {t('Add or remove them in your Umbrella profile')}
          </a>
        </Banner>
      )}
      {list.error && <Banner kind="error" title={list.error.message} />}
      {items.length === 0 && !list.busy && <p className="muted">{t('No passkeys yet.')}</p>}
      {items.length > 0 && (
        <ul className="passkey-list">
          {items.map((p) => (
            <li key={p.id}>
              <span className="pk-icon">
                <PasskeyIcon p={p} />
              </span>
              <span className="pk-text">
                <strong>{p.name}</strong>
                <small>
                  {t('Added {at}', { at: formatDate(p.created_at, false) })}
                  {' · '}
                  {p.last_used_at ? t('last used {at}', { at: formatDate(p.last_used_at, true) }) : t('not used yet')}
                  {p.backup_eligible ? ` · ${t('synced between your devices')}` : ''}
                  {p.from_hub ? ' · Umbrella' : ''}
                </small>
              </span>
              {!p.from_hub && (
                <>
                  <button type="button" className="icon-btn" aria-label={t('Rename')} title={t('Rename')} onClick={() => void rename(p)}>
                    <Pencil size={16} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={t('Remove')} title={t('Remove')} onClick={() => void remove(p)}>
                    <Trash2 size={16} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <ActionResult action={action} />
      {!fromHub && (
        <div className="card-actions">
          {!passkeysSupported() && <span className="hint">{t('This browser cannot use passkeys.')}</span>}
          <Button variant="primary" onClick={() => void add()} busy={action.busy} disabled={!passkeysSupported()}>
            <Fingerprint size={16} />
            {t('Add a passkey')}
          </Button>
        </div>
      )}
    </div>
  );
}

export function PasskeysDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={t('Passkeys')} onClose={onClose} width={560}>
      <PasskeysPanel />
    </Modal>
  );
}
