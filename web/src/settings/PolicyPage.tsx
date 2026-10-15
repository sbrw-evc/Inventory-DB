import { useState } from 'react';
import { DEFAULT_PASSWORD_POLICY, MAX_AGE_DAYS, MAX_WARN_DAYS, POLICY_LETTERS, policyError, type PasswordPolicy } from '@shared';
import { t } from '../i18n';
import { settingsApi } from './api';
import { lettersText, PolicyChecklist, problemText } from './policy';
import { ActionResult, Banner, Button, Card, Field, Password, Rows, Switch, useAction, useResource } from './ui';

const same = (a: PasswordPolicy, b: PasswordPolicy) => JSON.stringify(a) === JSON.stringify(b);

function NumberInput({ id, value, onChange, min, max }: { id: string; value: number; onChange: (n: number) => void; min: number; max: number }) {
  return (
    <input
      id={id}
      className="input"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={Number.isFinite(value) ? value : ''}
      onChange={(e) => onChange(e.target.value === '' ? NaN : Math.trunc(Number(e.target.value)))}
    />
  );
}

/** Rules for local account passwords (Umbrella's password policy page). */
export function PolicyPage() {
  const summary = useResource(settingsApi.policy);
  const [draft, setDraft] = useState<PasswordPolicy | null>(null);
  const [sample, setSample] = useState('');
  const saver = useAction();
  if (!summary.data) return summary.error ? <Banner kind="error" title={summary.error.message} /> : <p className="muted">{t('Loading…')}</p>;
  const saved = summary.data.policy;
  const p = draft ?? saved;
  const set = (patch: Partial<PasswordPolicy>) => setDraft({ ...p, ...patch });
  const problem = policyError(p);
  const dirty = !same(p, saved);
  const managed = !!summary.data.managed_by_hub;

  const save = () =>
    saver.run(async () => {
      summary.setData(await settingsApi.savePolicy(p));
      setDraft(null);
      return t('The password policy is saved.');
    });

  return (
    <div className="settings-stack">
      <Card title={t('Password policy')}>
        <p className="muted">{t('Rules for passwords of local accounts. Accounts from LDAP / AD and Entra ID follow the rules of the directory.')}</p>
        {managed && (
          <Banner kind="info" title={t('The policy comes from Umbrella Monitoring')}>
            {t('It is the same in Umbrella Monitoring, Umbrella Flow, Inventory DB and Network Control. Change it in Umbrella, or turn off “Use the password policy of Umbrella” in Settings → Single sign-in.')}
          </Banner>
        )}
        <Rows
          align="end"
          rows={[
            [t('Local accounts'), String(summary.data.local_users)],
            [t('Password expired'), String(summary.data.expired_users)],
            [t('Password expires soon'), String(summary.data.expiring_users)],
          ]}
        />
      </Card>
      <Card
        title={t('Rules')}
        onSubmit={managed ? undefined : save}
        footer={
          !managed && (
          <>
            <Button variant="ghost" onClick={() => setDraft(DEFAULT_PASSWORD_POLICY)} disabled={same(p, DEFAULT_PASSWORD_POLICY) || saver.busy}>
              {t('Recommended rules')}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={!dirty || saver.busy}>
              {t('Reset')}
            </Button>
            <Button type="submit" variant="primary" busy={saver.busy} disabled={!dirty || problem !== null}>
              {t('Save')}
            </Button>
          </>
          )
        }
      >
        <fieldset className="plain-fieldset" style={{ gap: 14 }} disabled={managed}>
        <div className="grid-2">
          <Field label={t('Minimum length')} hint={t('From 8 to 128 characters.')}>
            {(id) => <NumberInput id={id} value={p.min_length} min={8} max={128} onChange={(n) => set({ min_length: n })} />}
          </Field>
          <Field label={t('Letters')}>
            {(id) => (
              <select id={id} className="input" value={p.letters} onChange={(e) => set({ letters: e.target.value as PasswordPolicy['letters'] })}>
                {POLICY_LETTERS.map((l) => (
                  <option key={l} value={l}>
                    {lettersText(l)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <div className="grid-2">
          <div className="stack" style={{ gap: 6 }}>
            <Switch checked={p.require_digits} onChange={(v) => set({ require_digits: v })} label={t('Require digits')} />
            {p.require_digits && (
              <Field label={t('Digits, at least')}>{(id) => <NumberInput id={id} value={p.min_digits} min={1} max={16} onChange={(n) => set({ min_digits: n })} />}</Field>
            )}
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <Switch checked={p.require_special} onChange={(v) => set({ require_special: v })} label={t('Require special characters')} />
            {p.require_special && (
              <Field label={t('Special characters, at least')}>
                {(id) => <NumberInput id={id} value={p.min_special} min={1} max={16} onChange={(n) => set({ min_special: n })} />}
              </Field>
            )}
          </div>
        </div>
        <Switch checked={p.require_mixed_case} onChange={(v) => set({ require_mixed_case: v })} label={t('Require upper and lower case letters')} />
        <div className="grid-2">
          <Field label={t('Password lifetime, days')} hint={t('0 — passwords never expire.')}>
            {(id) => <NumberInput id={id} value={p.max_age_days} min={0} max={MAX_AGE_DAYS} onChange={(n) => set({ max_age_days: n })} />}
          </Field>
          {p.max_age_days > 0 && (
            <Field label={t('Warn before expiry, days')} hint={t('0 — no warning.')}>
              {(id) => <NumberInput id={id} value={p.warn_days} min={0} max={MAX_WARN_DAYS} onChange={(n) => set({ warn_days: n })} />}
            </Field>
          )}
        </div>
        <div className="grid-2">
          <Field label={t('Password history')} hint={t('A new password must differ from this many previous ones. 0 — not checked.')}>
            {(id) => <NumberInput id={id} value={p.history_count} min={0} max={24} onChange={(n) => set({ history_count: n })} />}
          </Field>
          <div className="stack" style={{ gap: 6, justifyContent: 'center' }}>
            <Switch
              checked={p.block_common}
              onChange={(v) => set({ block_common: v })}
              label={t('Block common passwords')}
              hint={t('Popular passwords, keyboard sequences and the login with a few characters added.')}
            />
          </div>
        </div>
        <div className="grid-2">
          <Field label={t('Lock the account after wrong passwords')} hint={t('0 — the built-in limits only.')}>
            {(id) => <NumberInput id={id} value={p.lockout_attempts} min={0} max={100} onChange={(n) => set({ lockout_attempts: n, lockout_minutes: n && !p.lockout_minutes ? 15 : p.lockout_minutes })} />}
          </Field>
          {p.lockout_attempts > 0 && (
            <Field label={t('Lock for, minutes')}>
              {(id) => <NumberInput id={id} value={p.lockout_minutes} min={1} max={1440} onChange={(n) => set({ lockout_minutes: n })} />}
            </Field>
          )}
        </div>
        </fieldset>
        {problem && <Banner kind="error" title={problemText(problem)} />}
        <Banner kind="info" title={t('New rules apply when a password is set or changed. Existing passwords keep working until they expire.')} />
        <ActionResult action={saver} />
      </Card>
      <Card title={t('Try a password')}>
        <p className="muted">{t('Type a password to see which rules it meets. It is not sent anywhere.')}</p>
        <Field label={t('Password')}>{(id) => <Password id={id} value={sample} onChange={setSample} autoComplete="off" />}</Field>
        <PolicyChecklist policy={p} password={sample} login="" />
      </Card>
    </div>
  );
}
