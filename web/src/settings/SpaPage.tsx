import { ExternalLink, RefreshCw } from 'lucide-react';
import { getLang, t } from '../i18n';
import { formatDate } from '../lib/format';
import { settingsApi, type SpaUserRow, type SpaView, type State } from './api';
import { ActionResult, Banner, Button, Card, Pill, Rows, Table, useAction, useResource } from './ui';

const SPA_PROTOCOL = 'https://github.com/sbrw-evc/keystone/blob/HEAD/docs/protocol.md';

const roleText = (r: string) => ({ admin: t('Administrator'), editor: t('Editor'), viewer: t('Viewer') })[r] ?? r;
const keySourceText = (s: SpaView['key_source']) =>
  s === 'environment' ? 'SPA_CONNECTION_KEY' : s === 'file' ? 'SPA_CONNECTION_KEY_FILE' : s === 'secret_store' ? t('Secret store (spa / connection_key)') : undefined;

const tokensText = (u: SpaUserRow) =>
  !u.api_tokens ? '' : u.suspended_tokens ? t('{n} (suspended: {s})', { n: u.api_tokens, s: u.suspended_tokens }) : String(u.api_tokens);

function stateOf(v: SpaView): State {
  if (!v.connected) return 'error';
  if (!v.last_sync) return 'warn';
  return v.ok ? 'ok' : 'error';
}

/** Settings → Keystone: the connection (issuer, application, last synchronization, counts, errors) and the users from Keystone. */
export function SpaPage() {
  const view = useResource(settingsApi.spa);
  const users = useResource(settingsApi.spaUsers);
  const sync = useAction();
  const locale = getLang();
  const num = (n: number) => n.toLocaleString(locale);
  const date = (v?: string | null) => (v ? formatDate(v, true) : undefined);
  const v = view.data;

  if (!v) return view.error ? <Banner kind="error" title={view.error.message} /> : <p className="muted">{t('Loading…')}</p>;

  const synchronize = () =>
    sync.run(async () => {
      view.setData(await settingsApi.syncSpa());
      users.reload();
      return t('Synchronized');
    });

  return (
    <div className="cards">
      <Card title={t('Connection')} badge={<Pill state={stateOf(v)} label={v.connected ? undefined : t('Not connected')} />} wide>
        <p className="muted">
          {t('Sign-in and access are managed in Keystone: passwords, passkeys, directories, sign-in providers and the roles of people in Ledger.')}{' '}
          <a href={SPA_PROTOCOL} target="_blank" rel="noreferrer">
            {t('How applications connect to Keystone')}
          </a>
        </p>
        {!v.connected && (
          <Banner kind="error" title={t('This application is not connected to Keystone')}>
            {v.key_error && <p>{t(v.key_error)}</p>}
            <p>
              {t('Copy the connection key (spa1.…) and give it to Ledger in the environment variable')} <code>SPA_CONNECTION_KEY</code>{' '}
              {t('(or the file named by SPA_CONNECTION_KEY_FILE, or the secret spa / connection_key in OpenBao), then restart it.')}
            </p>
          </Banner>
        )}
        <Rows
          rows={[
            [t('Issuer'), v.issuer && <code>{v.issuer}</code>],
            [t('Application'), v.application && `${v.application.name} (${v.application.type})`],
            [t('Client ID'), v.client_id && <code>{v.client_id}</code>],
            [t('Connection key from'), keySourceText(v.key_source)],
            [t('Redirect URI'), <code key="r">{v.redirect_uri}</code>],
            [t('Sign-in methods'), v.methods.length ? v.methods.map((m) => m.title).join(', ') : undefined],
            [
              t('Account and security'),
              v.account_url && (
                <a href={v.account_url} target="_blank" rel="noreferrer">
                  {v.account_url} <ExternalLink size={12} aria-hidden />
                </a>
              ),
            ],
            [t('Role catalogue published'), date(v.roles_published_at)],
          ]}
        />
        {v.roles_error && <Banner kind="warn" title={t('The role catalogue could not be published to Keystone')}>{v.roles_error}</Banner>}
      </Card>

      <Card
        title={t('Synchronization')}
        badge={v.connected && v.last_sync ? <Pill state={v.ok ? 'ok' : 'error'} /> : undefined}
        footer={
          v.connected && (
            <Button onClick={synchronize} busy={sync.busy}>
              {!sync.busy && <RefreshCw size={16} />}
              {t('Synchronize now')}
            </Button>
          )
        }
        wide
      >
        <p className="muted">{t('Users and their roles are read from Keystone every 5 minutes. People Keystone disables or removes lose their sessions here, and their API tokens are suspended until Keystone enables them again.')}</p>
        <Rows
          rows={[
            [t('Last synchronization'), date(v.last_sync) ?? t('Not yet')],
            [t('Last success'), date(v.last_success)],
            [t('Users with access'), v.last_success ? num(v.counts.users) : undefined],
            [t('Created / updated / disabled'), v.last_success ? `${num(v.counts.created)} / ${num(v.counts.updated)} / ${num(v.counts.disabled)}` : undefined],
            [t('Bound to existing records'), v.counts.matched ? num(v.counts.matched) : undefined],
            [t('Active users here'), num(v.users.active)],
            [t('Administrators'), num(v.users.admins)],
            [t('Disabled users'), v.users.disabled ? num(v.users.disabled) : undefined],
            [t('Last sign-in'), date(v.users.last_sign_in)],
          ]}
        />
        {v.error && v.connected && <Banner kind="error" title={t(v.error)} />}
        <ActionResult action={sync} />
      </Card>

      <Card title={t('Users')} badge={<span className="muted">{t('Managed in Keystone')}</span>} wide>
        {users.error && <Banner kind="error" title={users.error.message} />}
        {users.data && (
          <Table
            columns={[{ label: t('Name') }, { label: t('User name') }, { label: t('Email') }, { label: t('DCIM/IPAM role') }, { label: t('State') }, { label: t('API tokens') }, { label: t('Last sign-in') }]}
            rows={users.data.map((u) => ({
              key: u.id,
              cells: [
                u.name,
                u.username ?? '',
                u.email,
                roleText(u.role),
                u.disabled ? <Pill key="s" state="off" label={t('Disabled')} /> : u.source === 'spa' ? <Pill key="s" state="ok" label={t('Active')} /> : <Pill key="s" state="warn" label={t('Not yet in Keystone')} />,
                tokensText(u),
                date(u.last_sign_in_at) ?? '',
              ],
            }))}
          />
        )}
      </Card>
    </div>
  );
}
