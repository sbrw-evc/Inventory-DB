import { useState, type FormEvent } from 'react';
import { Modal } from '../components/Modal';
import { authApi } from '../api/endpoints';
import { t } from '../i18n';
import { useAuth } from '../lib/auth';
import { toast } from '../lib/toast';
import { PolicyChecklist } from './policy';
import { ActionResult, Button, Field, Password, useAction, useResource } from './ui';

/**
 * New password with the live policy checklist. Used on the sign-in page for an expired password and from the user
 * menu; signs in with the new password when it is saved.
 */
export function ChangePasswordForm({ login, current, onDone, onCancel }: { login: string; current?: string; onDone: () => void; onCancel?: () => void }) {
  const { changePassword } = useAuth();
  const providers = useResource(authApi.providers);
  const [old, setOld] = useState(current ?? '');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const action = useAction();
  const policy = providers.data?.password_policy;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await changePassword(login, old, next);
      onDone();
    });
  };
  return (
    <form className="stack" style={{ gap: 12 }} onSubmit={submit}>
      {current === undefined && (
        <Field label={t('Current password')}>{(id) => <Password id={id} value={old} onChange={setOld} autoComplete="current-password" />}</Field>
      )}
      <Field label={t('New password')}>{(id) => <Password id={id} value={next} onChange={setNext} />}</Field>
      <Field label={t('Repeat the new password')}>{(id) => <Password id={id} value={confirm} onChange={setConfirm} />}</Field>
      {policy && <PolicyChecklist policy={policy} password={next} login={login} confirm={confirm} />}
      <ActionResult action={action} />
      <div className="card-actions">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={action.busy}>
            {t('Cancel')}
          </Button>
        )}
        <Button type="submit" variant="primary" busy={action.busy} disabled={!old || !next || next !== confirm}>
          {t('Change password')}
        </Button>
      </div>
    </form>
  );
}

export function ChangePasswordDialog({ login, onClose }: { login: string; onClose: () => void }) {
  return (
    <Modal title={t('Change password')} onClose={onClose}>
      <ChangePasswordForm
        login={login}
        onCancel={onClose}
        onDone={() => {
          toast(t('Password changed'), 'success');
          onClose();
        }}
      />
    </Modal>
  );
}
