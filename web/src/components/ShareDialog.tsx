import { useState } from 'react';
import type { View } from '@shared';
import { platformApi } from '../api/endpoints';
import { useBaseCache } from '../api/hooks';
import { t } from '../i18n';
import { toast, toastError } from '../lib/toast';
import { Icon } from './Icon';
import { Modal } from './Modal';

export function shareUrl(view: Pick<View, 'type'>, uuid: string) {
  return `${window.location.origin}/shared/${view.type === 'form' ? 'form' : 'view'}/${uuid}`;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(t('Link copied'), 'success', 1500);
}

export function ShareDialog({ baseId, view, onClose }: { baseId: string; view: View; onClose: () => void }) {
  const cache = useBaseCache();
  const [uuid, setUuid] = useState<string | null>(view.shareUuid ?? null);
  const [usePassword, setUsePassword] = useState(!!view.sharePasswordSet);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      const res = await platformApi.shareView(view.id, usePassword && password ? password : null);
      setUuid(res.shareUuid);
      cache.setView(baseId, { ...view, shareUuid: res.shareUuid, sharePasswordSet: usePassword && !!password });
      toast(usePassword && password ? t('Public link updated with password') : t('Public link enabled'), 'success');
      setPassword('');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await platformApi.unshareView(view.id);
      setUuid(null);
      cache.setView(baseId, { ...view, shareUuid: null, sharePasswordSet: false });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const url = uuid ? shareUrl(view, uuid) : '';
  return (
    <Modal title={<><Icon name="share" /> {t('Share view “{name}”', { name: view.title })}</>} onClose={onClose} width={520}>
      <p className="muted">
        {view.type === 'form'
          ? t('Anyone with the link can submit this form, without signing in.')
          : t('Anyone with the link can see this view’s visible fields and records (read-only).')}
      </p>
      {uuid ? (
        <div className="share-link">
          <input className="input mono" readOnly value={url} onFocus={(e) => e.target.select()} />
          <button className="btn btn-primary" onClick={() => copyText(url)}>
            <Icon name="copy" size={14} /> {t('Copy')}
          </button>
          <a className="btn" href={url} target="_blank" rel="noreferrer">
            {t('Open')}
          </a>
        </div>
      ) : (
        <div className="notice">{t('Public sharing is off for this view.')}</div>
      )}
      <label className="checkbox-label">
        <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} /> {t('Protect with a password')}
      </label>
      {usePassword && (
        <input
          className="input"
          type="password"
          placeholder={view.sharePasswordSet ? t('Enter a new password to change it') : t('Password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      )}
      <div className="modal-actions">
        {uuid && (
          <button className="btn btn-danger-outline" onClick={disable} disabled={busy}>
            {t('Disable public link')}
          </button>
        )}
        <span className="spacer" />
        <button className="btn btn-primary" onClick={enable} disabled={busy || (usePassword && !password && !view.sharePasswordSet)}>
          {uuid ? t('Update link settings') : t('Create public link')}
        </button>
      </div>
    </Modal>
  );
}
