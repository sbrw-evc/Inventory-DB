import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { t } from '../i18n';
import { formatDate } from '../lib/format';
import { settingsApi, type AccountStats, type EntraCloud, type EntraConfig, type EntraReport, type EntraView, type LdapConfig, type LdapKind, type LdapReport, type LdapView } from './api';
import { ActionResult, Banner, Button, Card, Field, Password, Rows, Switch, useAction, useResource } from './ui';

const LDAP_DEFAULTS: Record<LdapKind, Pick<LdapConfig, 'user_filter' | 'username_attr' | 'name_attr' | 'email_attr'>> = {
  ad: { user_filter: '(&(objectCategory=person)(objectClass=user)(sAMAccountName={username}))', username_attr: 'sAMAccountName', name_attr: 'displayName', email_attr: 'mail' },
  openldap: { user_filter: '(&(objectClass=inetOrgPerson)(uid={username}))', username_attr: 'uid', name_attr: 'cn', email_attr: 'mail' },
};
const CALLBACK = '/api/v1/auth/entra/callback';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOUDS: EntraCloud[] = ['global', 'usgov', 'china'];

const reveal = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: 'auto' },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const },
};

function StatePill({ on }: { on: boolean }) {
  return <span className={`pill pill-${on ? 'ok' : 'off'}`}>{on ? t('On') : t('Off')}</span>;
}

function usersText(u: AccountStats) {
  return t('{total} (administrators: {admins}, disabled: {disabled})', { total: u.total, admins: u.admins, disabled: u.disabled });
}

function TextInput({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} autoComplete="off" />;
}

/** Keeps the attribute defaults in step when the directory kind changes (values the admin typed stay). */
function withKind(c: LdapConfig, kind: LdapKind): LdapConfig {
  const old = LDAP_DEFAULTS[c.kind];
  const next = { ...c, kind };
  for (const k of Object.keys(old) as (keyof typeof old)[]) if (!c[k] || c[k] === old[k]) next[k] = LDAP_DEFAULTS[kind][k];
  return next;
}

const sameLdap = (a: LdapConfig, b: LdapConfig) => a.url.trim().toLowerCase() === b.url.trim().toLowerCase() && a.bind_dn.trim().toLowerCase() === b.bind_dn.trim().toLowerCase();
const ldapKey = (c: LdapConfig, password: string) => JSON.stringify({ c: { ...c, enabled: true }, password });

function LdapSettings() {
  const view = useResource(settingsApi.ldap);
  const [draft, setDraft] = useState<LdapConfig | null>(null);
  const [password, setPassword] = useState('');
  const [testUser, setTestUser] = useState('');
  const [testPassword, setTestPassword] = useState('');
  const [check, setCheck] = useState<{ key: string; report: LdapReport } | null>(null);
  const saver = useAction();
  const tester = useAction();
  if (!view.data) return view.error ? <Banner kind="error" title={view.error.message} /> : null;
  const v: LdapView = view.data;
  const saved = v.config;
  const c = draft ?? saved;
  const set = (patch: Partial<LdapConfig>) => setDraft({ ...c, ...patch });
  const reusable = v.bind_password_set && sameLdap(c, saved);
  const passwordReady = password !== '' || reusable;
  const complete = !!(c.url.trim() && c.bind_dn.trim() && c.base_dn.trim());
  const dirty = c.enabled !== saved.enabled || (c.enabled && (JSON.stringify(c) !== JSON.stringify(saved) || password !== ''));
  const turningOff = saved.enabled && !c.enabled;
  const blocked = turningOff && v.local_admins === 0;

  const test = () =>
    tester.run(async () => {
      const key = ldapKey(c, password);
      const report = await settingsApi.testLdap({ config: c, bind_password: password || undefined, test_username: testUser.trim() || undefined, test_password: testPassword || undefined });
      setCheck({ key, report });
    });
  const save = () =>
    saver.run(async () => {
      view.setData(await settingsApi.saveLdap(c.enabled ? { config: c, bind_password: password || undefined } : { config: { enabled: false } }));
      setDraft(null);
      setPassword('');
      setCheck(null);
      return t('LDAP settings are saved.');
    });
  const passwordHint = password ? undefined : v.bind_password_set && !reusable ? t('The server or account changed: enter the password again.') : reusable ? t('Leave empty to keep the saved password.') : undefined;
  const report = check && check.key === ldapKey(c, password) ? check.report : null;

  return (
    <>
      <Card title={t('LDAP / Active Directory')} badge={<StatePill on={saved.enabled} />}>
        <p className="muted">{t('Users sign in with their directory account. Members of the administrators group get the administrator role.')}</p>
        <Rows
          align="end"
          rows={[
            ...(saved.url
              ? ([
                  [t('Directory'), saved.kind === 'ad' ? 'Active Directory' : 'OpenLDAP'],
                  [t('Server'), <code key="u">{saved.url}</code>],
                  [t('Encryption'), saved.url.toLowerCase().startsWith('ldaps://') ? 'LDAPS' : saved.start_tls ? 'StartTLS' : t('None')],
                  [t('Base DN'), saved.base_dn],
                  [t('Administrators group'), saved.admin_group_dn],
                  [t('Service account password'), v.bind_password_set ? t('Saved in {store}', { store: v.secrets === 'openbao' ? 'OpenBao' : t('the database') }) : t('Not set')],
                ] as [ReactNode, ReactNode][])
              : []),
            [t('Directory users'), usersText(v.users)],
            [t('Last sign-in'), formatDate(v.users.last_sign_in, true) || '—'],
            [t('Local administrators'), String(v.local_admins)],
          ]}
        />
      </Card>
      <Card
        title={t('LDAP settings')}
        onSubmit={save}
        footer={
          <>
            {c.enabled && <span className="hint">{t('Check the connection before saving.')}</span>}
            {c.enabled && (
              <Button onClick={test} busy={tester.busy} disabled={!complete || !passwordReady}>
                {t('Check')}
              </Button>
            )}
            <Button type="submit" variant="primary" busy={saver.busy} disabled={!dirty || blocked || (c.enabled && (!complete || !passwordReady))}>
              {t('Save')}
            </Button>
          </>
        }
      >
        <Switch checked={c.enabled} onChange={(on) => set({ enabled: on })} label={t('Sign-in with LDAP / AD')} hint={t('Local accounts keep working.')} />
        <AnimatePresence initial={false} mode="wait">
          {c.enabled ? (
            <motion.div key="on" className="reveal-box" {...reveal}>
              <div className="stack">
                <div className="segmented" role="radiogroup" aria-label={t('Directory')}>
                  {(['ad', 'openldap'] as LdapKind[]).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={c.kind === k} className={c.kind === k ? 'active' : ''} onClick={() => setDraft(withKind(c, k))}>
                      {k === 'ad' ? 'Active Directory' : 'OpenLDAP'}
                    </button>
                  ))}
                </div>
                <div className="plain-fieldset">
                  <Field label={t('Server address')} hint={t('ldaps://dc.example.com:636, or ldap:// with StartTLS.')}>
                    {(id) => <TextInput id={id} value={c.url} onChange={(url) => set({ url })} placeholder="ldaps://dc.example.com" />}
                  </Field>
                  <div className="grid-2">
                    <Switch checked={c.start_tls} onChange={(start_tls) => set({ start_tls })} label="StartTLS" hint={t('Encrypt an ldap:// connection.')} />
                    <Switch checked={c.skip_verify} onChange={(skip_verify) => set({ skip_verify })} label={t('Do not check the certificate')} hint={t('Only for testing.')} />
                  </div>
                  <Field label={t('CA certificate (PEM)')} optional hint={t('For a server certificate issued by your own CA.')}>
                    {(id) => <textarea id={id} className="input" value={c.ca_cert} onChange={(e) => set({ ca_cert: e.target.value })} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" />}
                  </Field>
                  <div className="grid-2">
                    <Field label={t('Service account DN')}>
                      {(id) => <TextInput id={id} value={c.bind_dn} onChange={(bind_dn) => set({ bind_dn })} placeholder="CN=svc-inventory,OU=Service,DC=example,DC=com" />}
                    </Field>
                    <Field label={t('Service account password')} hint={passwordHint}>
                      {(id) => <Password id={id} value={password} onChange={setPassword} />}
                    </Field>
                  </div>
                  <div className="grid-2">
                    <Field label={t('Base DN')} hint={t('Users are searched below it.')}>
                      {(id) => <TextInput id={id} value={c.base_dn} onChange={(base_dn) => set({ base_dn })} placeholder="DC=example,DC=com" />}
                    </Field>
                    <Field label={t('Administrators group DN')} optional>
                      {(id) => <TextInput id={id} value={c.admin_group_dn} onChange={(admin_group_dn) => set({ admin_group_dn })} placeholder="CN=Inventory Admins,OU=Groups,DC=example,DC=com" />}
                    </Field>
                  </div>
                  <Field label={t('User filter')} hint={t('{username} is replaced with the name typed at sign-in.')}>
                    {(id) => <TextInput id={id} value={c.user_filter} onChange={(user_filter) => set({ user_filter })} />}
                  </Field>
                  <div className="grid-2">
                    <Field label={t('Login attribute')}>{(id) => <TextInput id={id} value={c.username_attr} onChange={(username_attr) => set({ username_attr })} />}</Field>
                    <Field label={t('Name attribute')}>{(id) => <TextInput id={id} value={c.name_attr} onChange={(name_attr) => set({ name_attr })} />}</Field>
                  </div>
                  <div className="grid-2">
                    <Field label={t('Email attribute')}>{(id) => <TextInput id={id} value={c.email_attr} onChange={(email_attr) => set({ email_attr })} />}</Field>
                  </div>
                  <div className="grid-2">
                    <Field label={t('Test user')} optional hint={t('Checks that this user can sign in.')}>
                      {(id) => <TextInput id={id} value={testUser} onChange={setTestUser} />}
                    </Field>
                    <Field label={t('Test user password')} optional>
                      {(id) => <Password id={id} value={testPassword} onChange={setTestPassword} autoComplete="off" />}
                    </Field>
                  </div>
                </div>
                {check && !report && <Banner kind="info" title={t('Settings changed after the check. Check the connection again.')} />}
                {report &&
                  (report.ok && report.probe ? (
                    <Banner kind="ok" title={t('The directory answers')}>
                      <Rows
                        rows={[
                          [t('Encryption'), report.probe.tls === 'ldaps' ? 'LDAPS' : report.probe.tls === 'starttls' ? 'StartTLS' : t('None')],
                          [t('Administrators group'), report.probe.admin_group ? t('Found') : ''],
                          [t('Test user'), report.probe.user && `${report.probe.user.name} <${report.probe.user.email}>`],
                          [t('Administrator'), report.probe.user ? (report.probe.user.admin ? t('Yes') : t('No')) : ''],
                        ]}
                      />
                    </Banner>
                  ) : (
                    <Banner kind="error" title={t('The directory does not answer')}>
                      {report.error}
                    </Banner>
                  ))}
                <ActionResult action={tester} />
              </div>
            </motion.div>
          ) : (
            <motion.div key="off" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              {blocked ? (
                <Banner kind="error" title={t('No local administrator is left: create one before turning directory sign-in off.')} />
              ) : (
                <Banner kind="info" title={t('Directory users cannot sign in while this is off.')} />
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <ActionResult action={saver} />
      </Card>
    </>
  );
}

const defaultRedirect = () => window.location.origin + CALLBACK;
const sameEntra = (a: EntraConfig, b: EntraConfig) =>
  a.cloud === b.cloud && a.tenant_id.trim().toLowerCase() === b.tenant_id.trim().toLowerCase() && a.client_id.trim().toLowerCase() === b.client_id.trim().toLowerCase();

function EntraSettings() {
  const view = useResource(settingsApi.entra);
  const [draft, setDraft] = useState<EntraConfig | null>(null);
  const [secret, setSecret] = useState('');
  const [check, setCheck] = useState<{ key: string; report: EntraReport } | null>(null);
  const saver = useAction();
  const tester = useAction();
  if (!view.data) return view.error ? <Banner kind="error" title={view.error.message} /> : null;
  const v: EntraView = view.data;
  const saved = { ...v.config, redirect_url: v.config.redirect_url || defaultRedirect() };
  const c = draft ?? saved;
  const set = (patch: Partial<EntraConfig>) => setDraft({ ...c, ...patch });
  const reusable = v.client_secret_set && sameEntra(c, saved);
  const secretReady = secret !== '' || reusable;
  const groups = [c.admin_group_id, c.user_group_id].map((g) => g.trim()).filter(Boolean);
  const complete = c.tenant_id.trim() !== '' && GUID.test(c.client_id.trim()) && groups.every((g) => GUID.test(g)) && c.redirect_url.trim().endsWith(CALLBACK);
  const dirty = c.enabled !== v.config.enabled || (c.enabled && (JSON.stringify(c) !== JSON.stringify(v.config) || secret !== ''));
  const blocked = v.config.enabled && !c.enabled && v.local_admins === 0;
  const key = JSON.stringify({ c, secret });
  const report = check && check.key === key ? check.report : null;

  const test = () =>
    tester.run(async () => {
      setCheck({ key, report: await settingsApi.testEntra({ config: { ...c, enabled: true }, client_secret: secret || undefined }) });
    });
  const save = () =>
    saver.run(async () => {
      view.setData(await settingsApi.saveEntra(c.enabled ? { config: c, client_secret: secret || undefined } : { config: { enabled: false } }));
      setDraft(null);
      setSecret('');
      setCheck(null);
      return t('Entra ID settings are saved.');
    });
  const secretHint = secret ? undefined : v.client_secret_set && !reusable ? t('The tenant or application changed: enter the secret again.') : reusable ? t('Leave empty to keep the saved secret.') : t('Certificates & secrets → New client secret, the Value column.');
  const cloudName = (cl: EntraCloud) => ({ global: t('Global (login.microsoftonline.com)'), usgov: t('US Government'), china: t('China (21Vianet)') })[cl];

  return (
    <>
      <Card title={t('Microsoft Entra ID')} badge={<StatePill on={v.config.enabled} />}>
        <p className="muted">{t('Users sign in with their Microsoft work account (single sign-on).')}</p>
        <Rows
          align="end"
          rows={[
            ...(v.config.tenant_id
              ? ([
                  [t('Directory (tenant) ID'), <code key="t">{v.config.tenant_id}</code>],
                  [t('Application (client) ID'), <code key="c">{v.config.client_id}</code>],
                  [t('Administrators group'), v.config.admin_group_id && <code key="a">{v.config.admin_group_id}</code>],
                  [t('Users group'), v.config.user_group_id ? <code key="u">{v.config.user_group_id}</code> : t('Anyone in the tenant')],
                  [t('Client secret'), v.client_secret_set ? t('Saved in {store}', { store: v.secrets === 'openbao' ? 'OpenBao' : t('the database') }) : t('Not set')],
                ] as [ReactNode, ReactNode][])
              : []),
            [t('Entra ID users'), usersText(v.users)],
            [t('Last sign-in'), formatDate(v.users.last_sign_in, true) || '—'],
          ]}
        />
      </Card>
      <Card
        title={t('Entra ID settings')}
        onSubmit={save}
        footer={
          <>
            {c.enabled && <span className="hint">{t('Check the connection before saving.')}</span>}
            {c.enabled && (
              <Button onClick={test} busy={tester.busy} disabled={!complete || !secretReady}>
                {t('Check')}
              </Button>
            )}
            <Button type="submit" variant="primary" busy={saver.busy} disabled={!dirty || blocked || (c.enabled && (!complete || !secretReady))}>
              {t('Save')}
            </Button>
          </>
        }
      >
        <Switch checked={c.enabled} onChange={(on) => set({ enabled: on })} label={t('Sign-in with Microsoft')} hint={t('A “Sign in with Microsoft” button appears on the sign-in page.')} />
        <AnimatePresence initial={false} mode="wait">
          {c.enabled ? (
            <motion.div key="on" className="reveal-box" {...reveal}>
              <div className="stack">
                <div className="plain-fieldset">
                  <p className="hint">{t('Register an application in Entra ID (App registrations → New registration), add the redirect URI below as a Web platform URI and create a client secret.')}</p>
                  <Field label={t('Redirect URI')} hint={t('Must match the URI registered for the application.')}>
                    {(id) => <TextInput id={id} value={c.redirect_url} onChange={(redirect_url) => set({ redirect_url })} />}
                  </Field>
                  <Field label={t('Cloud')}>
                    {(id) => (
                      <select id={id} className="input" value={c.cloud} onChange={(e) => set({ cloud: e.target.value as EntraCloud })}>
                        {CLOUDS.map((cl) => (
                          <option key={cl} value={cl}>
                            {cloudName(cl)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <div className="grid-2">
                    <Field label={t('Directory (tenant) ID')} hint={t('A GUID or a domain such as contoso.onmicrosoft.com.')}>
                      {(id) => <TextInput id={id} value={c.tenant_id} onChange={(tenant_id) => set({ tenant_id })} />}
                    </Field>
                    <Field label={t('Application (client) ID')}>{(id) => <TextInput id={id} value={c.client_id} onChange={(client_id) => set({ client_id })} />}</Field>
                  </div>
                  <Field label={t('Client secret')} hint={secretHint}>
                    {(id) => <Password id={id} value={secret} onChange={setSecret} />}
                  </Field>
                  <div className="grid-2">
                    <Field label={t('Administrators group ID')} optional hint={t('Object ID of the group whose members become administrators.')}>
                      {(id) => <TextInput id={id} value={c.admin_group_id} onChange={(admin_group_id) => set({ admin_group_id })} placeholder="00000000-0000-0000-0000-000000000000" />}
                    </Field>
                    <Field label={t('Users group ID')} optional hint={t('Only its members may sign in. Empty: anyone in the tenant.')}>
                      {(id) => <TextInput id={id} value={c.user_group_id} onChange={(user_group_id) => set({ user_group_id })} placeholder="00000000-0000-0000-0000-000000000000" />}
                    </Field>
                  </div>
                  {groups.length > 0 && <p className="hint">{t('Add a groups claim to the token (Token configuration → Add groups claim → Security groups), or grant the GroupMember.Read.All permission.')}</p>}
                </div>
                {check && !report && <Banner kind="info" title={t('Settings changed after the check. Check the connection again.')} />}
                {report &&
                  (report.ok ? (
                    <Banner kind="ok" title={t('Entra ID accepts the application and the secret')}>
                      <Rows rows={[[t('Issuer'), report.probe?.issuer && <code key="i">{report.probe.issuer}</code>]]} />
                    </Banner>
                  ) : (
                    <Banner kind="error" title={t('Entra ID rejected the settings')}>
                      {report.error}
                    </Banner>
                  ))}
                <ActionResult action={tester} />
              </div>
            </motion.div>
          ) : (
            <motion.div key="off" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              {blocked ? (
                <Banner kind="error" title={t('No local administrator is left: create one before turning directory sign-in off.')} />
              ) : (
                <Banner kind="info" title={t('Entra ID users cannot sign in while this is off.')} />
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <ActionResult action={saver} />
      </Card>
    </>
  );
}

/** LDAP / AD and Entra ID sign-in (Umbrella's directory settings page). */
export function DirectoryPage() {
  return (
    <div className="settings-stack">
      <LdapSettings />
      <EntraSettings />
    </div>
  );
}
