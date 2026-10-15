import { useEffect, useState } from 'react';
import { Copy, Plus, RefreshCw, Trash2, Unplug } from 'lucide-react';
import { copyText } from '../components/ShareDialog';
import { confirmDialog } from '../components/dialogs';
import { t } from '../i18n';
import { formatDate } from '../lib/format';
import {
  settingsApi,
  type IdbRole,
  type MappedRole,
  type PasskeySettings,
  type ProviderConfig,
  type ProviderKind,
  type ProvidersView,
  type UmbrellaCheck,
  type UmbrellaInput,
  type UmbrellaView,
} from './api';
import { ActionResult, Banner, Button, Card, Field, Password, Pill, Rows, Switch, useAction, useResource } from './ui';

const ROLES: IdbRole[] = ['admin', 'editor', 'viewer'];
const roleText = (r: MappedRole) => ({ admin: t('Administrator'), editor: t('Editor'), viewer: t('Viewer'), none: t('No access') })[r];

function RoleSelect({ id, value, onChange, allowNone }: { id?: string; value: MappedRole; onChange: (r: MappedRole) => void; allowNone?: boolean }) {
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value as MappedRole)}>
      {[...ROLES, ...(allowNone ? (['none'] as const) : [])].map((r) => (
        <option key={r} value={r}>
          {roleText(r)}
        </option>
      ))}
    </select>
  );
}

function CopyField({ value }: { value: string }) {
  return (
    <div className="copy-field">
      <input className="input" readOnly value={value} onFocus={(e) => e.target.select()} />
      <button type="button" className="btn" onClick={() => void copyText(value)} aria-label={t('Copy')}>
        <Copy size={16} />
      </button>
    </div>
  );
}

function Steps({ items, current }: { items: string[]; current: number }) {
  return (
    <ol className="steps">
      {items.map((s, i) => (
        <li key={s} className={i < current ? 'done' : i === current ? 'current' : ''}>
          {s}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- the address of Inventory DB

function PublicUrlCard({ value, onSaved }: { value: string; onSaved: () => void }) {
  const [url, setUrl] = useState(value);
  const action = useAction();
  useEffect(() => setUrl(value), [value]);
  return (
    <Card
      title={t('Address of Inventory DB')}
      onSubmit={() =>
        void action.run(async () => {
          await settingsApi.savePublicUrl(url);
          onSaved();
          return t('The address is saved.');
        })
      }
      footer={
        <Button type="submit" variant="primary" busy={action.busy} disabled={url.trim().replace(/\/+$/, '') === value}>
          {t('Save')}
        </Button>
      }
    >
      <p className="muted">{t('The address people open Inventory DB at. Umbrella and the sign-in providers send people back to it.')}</p>
      <Field label={t('Address')} hint={t('Leave empty to use the address of the current request.')}>
        {(id) => <input id={id} className="input" placeholder="https://inventory.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />}
      </Field>
      <ActionResult action={action} />
    </Card>
  );
}

// ---------------------------------------------------------------- Umbrella single sign-in

type Options = Omit<UmbrellaInput, 'key'>;

const optionsOf = (v: UmbrellaView): Options => ({
  enabled: v.connected ? v.enabled : true,
  role_map: v.role_map,
  admin_role: v.admin_role,
  default_role: v.default_role,
  link_local: v.link_local,
  sso: v.sso,
  sync_users: v.sync_users,
  sync_policy: v.sync_policy,
  sync_passkeys: v.sync_passkeys,
});

function UmbrellaOptions({ o, set, check }: { o: Options; set: (p: Partial<Options>) => void; check?: UmbrellaCheck | null }) {
  const suggestions = check ? [...check.roles, ...check.groups] : [];
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid-2">
        <Field label={t('Umbrella administrators get')}>{(id) => <RoleSelect id={id} value={o.admin_role} onChange={(r) => set({ admin_role: r })} allowNone />}</Field>
        <Field label={t('Everyone else gets')} hint={t('Unless a rule below matches their Umbrella role or group.')}>
          {(id) => <RoleSelect id={id} value={o.default_role} onChange={(r) => set({ default_role: r })} allowNone />}
        </Field>
      </div>
      <div className="role-map">
        <span className="field-label">{t('Roles by Umbrella role or group')}</span>
        {o.role_map.map((m, i) => (
          <div className="row" key={i}>
            <input
              className="input"
              list="umbrella-groups"
              placeholder={t('Umbrella role or group')}
              value={m.match}
              onChange={(e) => set({ role_map: o.role_map.map((x, j) => (j === i ? { ...x, match: e.target.value } : x)) })}
            />
            <RoleSelect value={m.role} onChange={(r) => set({ role_map: o.role_map.map((x, j) => (j === i ? { ...x, role: r as IdbRole } : x)) })} />
            <button type="button" className="icon-btn" aria-label={t('Remove')} onClick={() => set({ role_map: o.role_map.filter((_, j) => j !== i) })}>
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        <datalist id="umbrella-groups">
          {suggestions.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
        <div>
          <Button variant="ghost" onClick={() => set({ role_map: [...o.role_map, { match: '', role: 'editor' }] })}>
            <Plus size={16} />
            {t('Add a rule')}
          </Button>
        </div>
      </div>
      <Switch checked={o.sso} onChange={(v) => set({ sso: v })} label={t('“Sign in with Umbrella” button')} hint={t('People sign in once in Umbrella Monitoring and open Inventory DB without a password.')} />
      <Switch checked={o.sync_users} onChange={(v) => set({ sync_users: v })} label={t('Synchronise users')} hint={t('Accounts are created, updated and disabled as in Umbrella every 5 minutes.')} />
      <Switch checked={o.link_local} onChange={(v) => set({ link_local: v })} label={t('Take over local accounts with the same e-mail')} hint={t('Local administrators always keep their password.')} />
      <Switch checked={o.sync_policy} onChange={(v) => set({ sync_policy: v })} label={t('Use the password policy of Umbrella')} hint={t('The policy of local accounts becomes read-only here.')} />
      <Switch checked={o.sync_passkeys} onChange={(v) => set({ sync_passkeys: v })} label={t('Use the passkeys registered in Umbrella')} hint={t('Works when Inventory DB is on a subdomain of the Umbrella passkey domain.')} />
    </div>
  );
}

function CheckSummary({ c }: { c: UmbrellaCheck }) {
  return (
    <>
      <Rows
        align="end"
        rows={[
          [t('Umbrella Monitoring'), c.hub],
          [t('Application'), c.application],
          [t('Users'), String(c.users)],
          [t('Sign-in methods'), c.methods.map((m) => m.title).join(', ')],
          [t('Passkeys'), c.passkeys.enabled ? (c.passkeys_here ? t('work here ({domain})', { domain: c.passkeys.rp_id }) : t('another domain ({domain})', { domain: c.passkeys.rp_id })) : t('Off')],
        ]}
      />
      {c.conflicts.length > 0 && (
        <Banner kind="warn" title={t('{n} accounts with the same e-mail sign in another way', { n: c.conflicts.length })}>
          <p>{c.conflicts.slice(0, 10).join(', ')}</p>
          <p>{t('Turn on “Take over local accounts” to link them, or they are skipped.')}</p>
        </Banner>
      )}
    </>
  );
}

/** Three steps: paste the key → check what comes from Umbrella and map the roles → connect. */
function ConnectWizard({ view, onDone, onCancel }: { view: UmbrellaView; onDone: (v: UmbrellaView) => void; onCancel?: () => void }) {
  const [step, setStep] = useState(0);
  const [key, setKey] = useState('');
  const [check, setCheck] = useState<UmbrellaCheck | null>(null);
  const [o, setO] = useState<Options>(optionsOf(view));
  const action = useAction();
  const set = (p: Partial<Options>) => setO({ ...o, ...p });
  const steps = [t('Connection key'), t('Roles and options'), t('Connect')];

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Steps items={steps} current={step} />
      {step === 0 && (
        <>
          <ol className="muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>{t('In Umbrella Monitoring open Settings → Sign-in and Umbrella Identity → Connected applications → Connect an application and choose Inventory DB.')}</li>
            <li>
              {t('Give it this redirect address:')} {view.redirect_uri ? <CopyField value={view.redirect_uri} /> : <b>{t('set the address of Inventory DB above')}</b>}
            </li>
            <li>{t('Copy the connection key it shows and paste it here.')}</li>
          </ol>
          <Field label={t('Connection key')}>
            {(id) => <textarea id={id} className="input" rows={3} placeholder="umbid1.…" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />}
          </Field>
        </>
      )}
      {step === 1 && check && (
        <>
          <CheckSummary c={check} />
          <UmbrellaOptions o={o} set={set} check={check} />
        </>
      )}
      {step === 2 && check && (
        <>
          <p className="muted">{t('Inventory DB will read the users and settings of Umbrella now and every 5 minutes.')}</p>
          <Rows
            align="end"
            rows={[
              [t('Umbrella Monitoring'), check.hub],
              [t('Users'), String(check.users)],
              [t('Umbrella administrators get'), roleText(o.admin_role)],
              [t('Everyone else gets'), roleText(o.default_role)],
              [t('Rules'), String(o.role_map.filter((m) => m.match.trim()).length)],
            ]}
          />
        </>
      )}
      <ActionResult action={action} />
      <div className="card-actions">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={action.busy}>
            {t('Cancel')}
          </Button>
        )}
        {step > 0 && (
          <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={action.busy}>
            {t('Back')}
          </Button>
        )}
        {step === 0 && (
          <Button
            variant="primary"
            busy={action.busy}
            disabled={!key.trim()}
            onClick={() =>
              void action.run(async () => {
                setCheck(await settingsApi.checkUmbrella(key.trim()));
                setStep(1);
              })
            }
          >
            {t('Check the key')}
          </Button>
        )}
        {step === 1 && (
          <Button variant="primary" onClick={() => setStep(2)}>
            {t('Next')}
          </Button>
        )}
        {step === 2 && (
          <Button
            variant="primary"
            busy={action.busy}
            onClick={() =>
              void action.run(async () => {
                onDone(await settingsApi.saveUmbrella({ ...o, enabled: true, key: key.trim() }));
              })
            }
          >
            {t('Connect')}
          </Button>
        )}
      </div>
    </div>
  );
}

function UmbrellaCard() {
  const res = useResource(settingsApi.umbrella);
  const [wizard, setWizard] = useState(false);
  const [draft, setDraft] = useState<Options | null>(null);
  const action = useAction();
  const v = res.data;
  if (!v) return <Card title={t('Umbrella single sign-in')}>{res.error ? <Banner kind="error" title={res.error.message} /> : <p className="muted">{t('Loading…')}</p>}</Card>;
  const live = v.connected && v.enabled;
  const done = (n: UmbrellaView) => {
    res.setData(n);
    setWizard(false);
    setDraft(null);
  };
  const o = draft ?? optionsOf(v);
  const st = v.status;

  return (
    <Card title={t('Umbrella single sign-in')} badge={<Pill state={!live ? 'off' : st.ok ? 'ok' : st.error ? 'error' : 'warn'} label={!live ? t('Off') : undefined} />} wide>
      <p className="muted">
        {t('Connect Inventory DB to Umbrella Monitoring: one account and one sign-in for Umbrella Monitoring, Umbrella Flow, Inventory DB and Network Control, with the same users, password policy and passkeys.')}
      </p>
      {!live || wizard ? (
        <ConnectWizard view={v} onDone={done} onCancel={wizard ? () => setWizard(false) : undefined} />
      ) : (
        <>
          <Rows
            align="end"
            rows={[
              [t('Umbrella Monitoring'), <a href={v.hub} target="_blank" rel="noreferrer">{v.hub}</a>],
              [t('Application'), v.application],
              [t('Last synchronisation'), st.last_sync ? formatDate(st.last_sync, true) : t('not yet')],
              [t('Users'), t('{n} · created {c} · updated {u} · disabled {d}', { n: st.users, c: st.created, u: st.updated, d: st.disabled })],
              [t('Sign-in methods'), v.methods.map((m) => m.title).join(', ')],
              [t('Passkeys'), v.hub_passkeys.enabled ? v.hub_passkeys.rp_id : t('Off')],
            ]}
          />
          {st.error && <Banner kind="error" title={t('The last synchronisation failed')}>{st.error}</Banner>}
          {st.conflicts.length > 0 && (
            <Banner kind="warn" title={t('{n} accounts with the same e-mail sign in another way', { n: st.conflicts.length })}>
              {st.conflicts.slice(0, 10).join(', ')}
            </Banner>
          )}
          <UmbrellaOptions o={o} set={(p) => setDraft({ ...o, ...p })} />
          <ActionResult action={action} />
          <div className="card-actions">
            <Button
              variant="danger"
              disabled={action.busy}
              onClick={() =>
                void (async () => {
                  if (
                    !(await confirmDialog({
                      title: t('Disconnect from Umbrella?'),
                      message: t('Accounts from Umbrella are disabled; local accounts keep working.'),
                      confirmLabel: t('Disconnect'),
                      danger: true,
                    }))
                  )
                    return;
                  await action.run(async () => {
                    res.setData({ ...v, ...(await settingsApi.disconnectUmbrella()) });
                  });
                })()
              }
            >
              <Unplug size={16} />
              {t('Disconnect')}
            </Button>
            <Button variant="ghost" onClick={() => setWizard(true)} disabled={action.busy}>
              {t('New connection key')}
            </Button>
            <Button
              variant="ghost"
              busy={action.busy}
              onClick={() =>
                void action.run(async () => {
                  res.setData(await settingsApi.syncUmbrella());
                  return t('Synchronised.');
                })
              }
            >
              <RefreshCw size={16} />
              {t('Synchronise now')}
            </Button>
            <Button
              variant="primary"
              busy={action.busy}
              disabled={!draft}
              onClick={() =>
                void action.run(async () => {
                  done(await settingsApi.saveUmbrella(o));
                  return t('Saved.');
                })
              }
            >
              {t('Save')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- passkeys

function PasskeySettingsCard() {
  const res = useResource(settingsApi.passkeys);
  const [draft, setDraft] = useState<PasskeySettings | null>(null);
  const action = useAction();
  const v = res.data;
  if (!v) return <Card title={t('Passkeys')}>{res.error ? <Banner kind="error" title={res.error.message} /> : <p className="muted">{t('Loading…')}</p>}</Card>;
  const p = draft ?? v;
  return (
    <Card
      title={t('Passkeys')}
      badge={<Pill state={v.enabled ? 'ok' : 'off'} label={v.enabled ? t('On') : t('Off')} />}
      onSubmit={() =>
        void action.run(async () => {
          res.setData(await settingsApi.savePasskeys({ enabled: p.enabled, rp_id: p.rp_id }));
          setDraft(null);
          return t('Saved.');
        })
      }
      footer={
        !v.from_hub && (
          <Button type="submit" variant="primary" busy={action.busy} disabled={!draft}>
            {t('Save')}
          </Button>
        )
      }
    >
      <p className="muted">{t('Sign-in with Windows Hello (face, fingerprint, iris, PIN), Touch ID / Face ID, Android biometrics or a security key — phishing-resistant and without a password.')}</p>
      {v.from_hub ? (
        <Banner kind="info" title={t('Passkeys come from Umbrella Monitoring (domain {domain}).', { domain: v.effective_rp_id })} />
      ) : (
        <>
          <Switch checked={p.enabled} onChange={(e) => setDraft({ ...p, enabled: e })} label={t('Allow passkeys')} hint={t('People add them in the account menu → Passkeys.')} />
          <Field label={t('Passkey domain')} optional hint={t('A parent domain lets the same passkeys work on its subdomains. Default: {domain}.', { domain: v.effective_rp_id })}>
            {(id) => <input id={id} className="input" placeholder="example.com" value={p.rp_id} onChange={(e) => setDraft({ ...p, rp_id: e.target.value })} />}
          </Field>
        </>
      )}
      <ActionResult action={action} />
    </Card>
  );
}

// ---------------------------------------------------------------- Google, Apple, OpenID Connect

const KIND_TITLE: Record<ProviderKind, string> = { google: 'Google', apple: 'Apple', oidc: 'OpenID Connect' };

function ProviderCard({ kind, entry, onSaved }: { kind: ProviderKind; entry: ProvidersView['providers'][number]; onSaved: (v: ProvidersView) => void }) {
  const [c, setC] = useState<ProviderConfig>(entry.config);
  const [domains, setDomains] = useState(entry.config.allowed_domains.join(', '));
  const [secret, setSecret] = useState('');
  const [key, setKey] = useState('');
  const action = useAction();
  useEffect(() => {
    setC(entry.config);
    setDomains(entry.config.allowed_domains.join(', '));
  }, [entry.config]);
  const set = (p: Partial<ProviderConfig>) => setC({ ...c, ...p });
  const title = kind === 'oidc' ? c.title || KIND_TITLE.oidc : KIND_TITLE[kind];
  const save = () =>
    action.run(async () => {
      const config = { ...c, allowed_domains: domains.split(/[\s,;]+/).filter(Boolean) };
      onSaved(await settingsApi.saveProvider(kind, config, { client_secret: secret || undefined, private_key: key || undefined }));
      setSecret('');
      setKey('');
      return t('Saved.');
    });
  const readKey = async (f: File | undefined) => f && setKey(await f.text());

  return (
    <Card
      title={title}
      badge={<Pill state={entry.config.enabled ? 'ok' : 'off'} label={entry.config.enabled ? t('On') : t('Off')} />}
      onSubmit={() => void save()}
      footer={
        <Button type="submit" variant="primary" busy={action.busy}>
          {t('Save')}
        </Button>
      }
    >
      <Switch checked={c.enabled} onChange={(v) => set({ enabled: v })} label={t('“Sign in with {name}” button', { name: title })} />
      <Field label={t('Redirect address')} hint={t('Register it in the provider’s console.')}>
        {() => (entry.redirect_uri ? <CopyField value={entry.redirect_uri} /> : <span className="muted">{t('Set the address of Inventory DB first')}</span>)}
      </Field>
      {kind === 'oidc' && (
        <div className="grid-2">
          <Field label={t('Button title')}>{(id) => <input id={id} className="input" placeholder="Keycloak" value={c.title} onChange={(e) => set({ title: e.target.value })} />}</Field>
          <Field label={t('Issuer')}>{(id) => <input id={id} className="input" placeholder="https://sso.example.com/realms/corp" value={c.issuer} onChange={(e) => set({ issuer: e.target.value })} />}</Field>
        </div>
      )}
      <div className="grid-2">
        <Field label={kind === 'apple' ? t('Services ID') : t('Client ID')}>{(id) => <input id={id} className="input" value={c.client_id} onChange={(e) => set({ client_id: e.target.value })} />}</Field>
        {kind !== 'apple' && (
          <Field label={t('Client secret')} hint={entry.client_secret_set ? t('Saved in the secret store. Leave empty to keep it.') : undefined}>
            {(id) => <Password id={id} value={secret} onChange={setSecret} autoComplete="off" placeholder={entry.client_secret_set ? '••••••••' : ''} />}
          </Field>
        )}
      </div>
      {kind === 'apple' && (
        <>
          <div className="grid-2">
            <Field label={t('Team ID')}>{(id) => <input id={id} className="input" value={c.team_id} onChange={(e) => set({ team_id: e.target.value })} />}</Field>
            <Field label={t('Key ID')}>{(id) => <input id={id} className="input" value={c.key_id} onChange={(e) => set({ key_id: e.target.value })} />}</Field>
          </div>
          <Field label={t('Private key (.p8)')} hint={entry.private_key_set && !key ? t('Saved in the secret store. Upload a new one to replace it.') : key ? t('A new key is ready to be saved.') : undefined}>
            {(id) => <input id={id} className="input" type="file" accept=".p8,.pem,text/plain" onChange={(e) => void readKey(e.target.files?.[0])} />}
          </Field>
        </>
      )}
      <Field label={t('Allowed e-mail domains')} optional={kind === 'oidc'} hint={t('Comma-separated, for example example.com, example.org.')}>
        {(id) => <input id={id} className="input" placeholder="example.com" value={domains} onChange={(e) => setDomains(e.target.value)} />}
      </Field>
      <div className="grid-2">
        <Field label={t('New accounts get')}>{(id) => <RoleSelect id={id} value={c.role} onChange={(r) => set({ role: r as IdbRole })} />}</Field>
        {kind === 'oidc' && <Field label={t('Extra scopes')} optional>{(id) => <input id={id} className="input" placeholder="groups" value={c.scopes} onChange={(e) => set({ scopes: e.target.value })} />}</Field>}
      </div>
      {kind === 'oidc' && (
        <div className="grid-2">
          <Field label={t('Groups claim')} optional>{(id) => <input id={id} className="input" placeholder="groups" value={c.groups_claim} onChange={(e) => set({ groups_claim: e.target.value })} />}</Field>
          <Field label={t('Administrators group')} optional>{(id) => <input id={id} className="input" value={c.admin_group} onChange={(e) => set({ admin_group: e.target.value })} />}</Field>
        </div>
      )}
      <Switch checked={c.existing_only} onChange={(v) => set({ existing_only: v })} label={t('Only existing accounts may sign in')} hint={t('Nobody gets a new account; people sign in to the account with their e-mail.')} />
      <ActionResult action={action} />
    </Card>
  );
}

function ProvidersCards() {
  const res = useResource(settingsApi.providers);
  if (!res.data) return res.error ? <Banner kind="error" title={res.error.message} /> : <p className="muted">{t('Loading…')}</p>;
  return (
    <>
      {res.data.providers.map((p) => (
        <ProviderCard key={p.kind} kind={p.kind} entry={p} onSaved={res.setData} />
      ))}
    </>
  );
}

/** Umbrella single sign-in, passkeys and Google / Apple / OpenID Connect sign-in. */
export function IdentityPage() {
  const providers = useResource(settingsApi.providers);
  const [epoch, setEpoch] = useState(0);
  return (
    <div className="settings-stack">
      <PublicUrlCard
        value={providers.data?.public_url ?? ''}
        onSaved={() => {
          providers.reload();
          setEpoch(epoch + 1);
        }}
      />
      <UmbrellaCard key={`u${epoch}`} />
      <PasskeySettingsCard />
      <ProvidersCards key={`p${epoch}`} />
    </div>
  );
}
