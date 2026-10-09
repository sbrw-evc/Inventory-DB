import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { PageHead } from '../components/shell/PageHead';
import { getLang, t } from '../i18n';
import { formatDate } from '../lib/format';
import { settingsApi, type State } from './api';
import { baoRows, baoState } from './OpenBaoPage';
import { lettersText } from './policy';
import { Banner, Button, formatBytes, formatDuration, formatMs, Pill, Rows, useResource } from './ui';

function StatusCard({ title, state, label, wide, children }: { title: string; state?: State; label?: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`card status-card${wide ? ' span-all' : ''}`}>
      <header>
        <h2>{title}</h2>
        {state && <Pill state={state} label={label} />}
      </header>
      {children}
    </section>
  );
}

const yesNo = (v: boolean) => (v ? t('Yes') : t('No'));

/** One page with the state of every part of Inventory DB (Umbrella's system status page). */
export function StatusPage() {
  const status = useResource(settingsApi.status);
  const locale = getLang();
  const num = (n: number) => n.toLocaleString(locale);
  const date = (v?: string) => (v ? formatDate(v, true) : undefined);
  const head = (
    <PageHead
      title={t('System status')}
      subtitle={t('The state of Inventory DB and the services it depends on.')}
      actions={
        <Button onClick={status.reload} busy={status.busy}>
          {!status.busy && <RefreshCw size={16} />}
          {t('Refresh')}
        </Button>
      }
    />
  );
  const s = status.data;
  if (!s)
    return (
      <>
        {head}
        {status.error ? <Banner kind="error" title={status.error.message} /> : <p className="muted">{t('Loading…')}</p>}
      </>
    );

  const { build: b, runtime: rt, openbao: ob, postgres: pg, ldap: ld, entra: en, integrations: ig, inventory: inv, logs, settings } = s;
  const obState: State = s.secrets.backend === 'local' ? 'warn' : baoState(ob);
  const pgState: State = pg.ok ? 'ok' : 'error';
  const ldState: State = !ld.enabled ? 'off' : ld.ok ? 'ok' : 'error';
  const enState: State = !en.enabled ? 'off' : en.ok ? 'ok' : 'error';
  const errors = logs.counts.error ?? 0;
  const warnings = logs.counts.warn ?? 0;
  const logState: State = errors > 0 ? 'error' : warnings > 0 ? 'warn' : 'ok';
  const problems = [obState, pgState, ldState, enState].filter((x) => x === 'error').length;
  const users = inv.users.local + inv.users.ldap + inv.users.entra;
  const h = pg.health;
  const p = settings.password_policy;

  return (
    <>
      {head}
      {status.error && <Banner kind="error" title={status.error.message} />}
      <div className="status-summary">
        <Pill state={problems ? 'error' : 'ok'} label={problems ? t('Problems: {n}', { n: problems }) : t('Everything works')} />
        <span className="muted">{t('Checked {at}', { at: formatDate(s.checked_at, true) })}</span>
      </div>
      <div className="cards">
        <StatusCard title={t('Application')}>
          <Rows
            align="end"
            rows={[
              [t('Version'), b.version],
              [t('Commit'), b.commit && <code title={b.commit}>{b.commit.slice(0, 12)}</code>],
              ['Node.js', b.node_version],
              [t('Platform'), b.platform],
              [t('Started'), date(rt.started_at)],
              [t('Uptime'), formatDuration(rt.uptime_seconds)],
            ]}
          />
        </StatusCard>
        <StatusCard title={t('Runtime')}>
          <Rows
            align="end"
            rows={[
              [t('Host'), rt.hostname],
              ['PID', String(rt.pid)],
              [t('Processors'), String(rt.cpus)],
              [t('Load average'), rt.load.map((l) => l.toLocaleString(locale, { maximumFractionDigits: 2 })).join(' / ')],
              [t('Event loop delay'), formatMs(rt.event_loop_delay_ms, locale)],
              [t('Process memory'), formatBytes(rt.memory.rss_bytes, locale)],
              [t('JavaScript heap'), `${formatBytes(rt.memory.heap_used_bytes, locale)} / ${formatBytes(rt.memory.heap_total_bytes, locale)}`],
              [t('System memory free'), `${formatBytes(rt.system_memory.free_bytes, locale)} / ${formatBytes(rt.system_memory.total_bytes, locale)}`],
            ]}
          />
        </StatusCard>
        <StatusCard title="OpenBao" state={obState} label={s.secrets.backend === 'local' ? t('Not configured') : undefined}>
          {s.secrets.backend === 'local' ? (
            <Banner kind="warn" title={t('OpenBao is not configured')}>
              {t('{n} secrets are kept encrypted in the database.', { n: s.secrets.local })}
            </Banner>
          ) : (
            <Rows align="end" rows={[...baoRows(ob, locale), [t('Secrets in the database'), s.secrets.local ? String(s.secrets.local) : undefined]]} />
          )}
          {ob.error && <Banner kind="error" title={ob.error} />}
          {ob.last_error && (
            <Banner kind="warn" title={t('Last error')}>
              {ob.last_error}
              {ob.last_error_at && ` · ${formatDate(ob.last_error_at, true)}`}
            </Banner>
          )}
        </StatusCard>
        <StatusCard title="PostgreSQL" state={pgState}>
          <Rows
            align="end"
            rows={[
              [t('Database'), pg.where],
              [t('Server version'), h?.version],
              [t('Database size'), h && formatBytes(h.size_bytes, locale)],
              [t('Connections'), h && `${num(h.connections)} / ${num(h.max_connections)}`],
              ['SSL', h && yesNo(h.ssl)],
              [t('Server started'), date(h?.started_at)],
              [t('Response time'), pg.ok ? formatMs(pg.latency_ms, locale) : undefined],
            ]}
          />
          {pg.error && <Banner kind="error" title={pg.error} />}
        </StatusCard>
        <StatusCard title="LDAP / AD" state={ldState}>
          {ld.enabled ? (
            <Rows
              align="end"
              rows={[
                [t('Directory'), ld.kind === 'ad' ? 'Active Directory' : ld.kind === 'openldap' ? 'OpenLDAP' : undefined],
                [t('Server'), ld.url],
                [t('Encryption'), ld.tls === 'none' ? t('Off') : ld.tls === 'starttls' ? 'StartTLS' : ld.tls === 'ldaps' ? 'LDAPS' : undefined],
                [t('Search base'), ld.base_dn],
                [t('Administrators group'), ld.admin_group],
                [t('Users'), num(inv.users.ldap)],
                [t('Response time'), ld.ok ? formatMs(ld.latency_ms, locale) : undefined],
              ]}
            />
          ) : (
            <p className="muted">{t('Sign-in with LDAP / AD is off.')}</p>
          )}
          {ld.error && <Banner kind="error" title={ld.error} />}
        </StatusCard>
        <StatusCard title="Entra ID" state={enState}>
          {en.enabled ? (
            <Rows
              align="end"
              rows={[
                [t('Tenant'), en.tenant_id],
                [t('Application (client) ID'), en.client_id],
                [t('Redirect URI'), en.redirect_url],
                [t('Administrators group'), en.admin_group_id],
                [t('Users group'), en.user_group_id],
                [t('Client secret'), en.credentials ? t('Accepted') : t('Not checked')],
                [t('Users'), num(inv.users.entra)],
                [t('Response time'), en.ok ? formatMs(en.latency_ms, locale) : undefined],
              ]}
            />
          ) : (
            <p className="muted">{t('Sign-in with Entra ID is off.')}</p>
          )}
          {en.error && <Banner kind="error" title={en.error} />}
        </StatusCard>
        <StatusCard title={t('Integrations')}>
          <Rows
            align="end"
            rows={[
              [t('Integrations'), num(ig.total)],
              [t('Active'), num(ig.active)],
              [t('Last data received'), date(ig.last_feed_at)],
              [t('Last alert'), date(ig.last_alert_at)],
            ]}
          />
        </StatusCard>
        <StatusCard title={t('Inventory')}>
          <Rows
            align="end"
            rows={[
              [t('Users'), num(users)],
              [t('Local / LDAP / Entra ID'), `${num(inv.users.local)} / ${num(inv.users.ldap)} / ${num(inv.users.entra)}`],
              [t('Administrators'), num(inv.admins)],
              [t('Disabled users'), inv.disabled_users ? num(inv.disabled_users) : undefined],
              [t('Last sign-in'), date(inv.last_sign_in)],
              [t('Bases'), num(inv.bases)],
              [t('Tables'), num(inv.tables)],
              [t('Sites'), num(inv.sites)],
              [t('Devices'), num(inv.devices)],
              [t('Prefixes'), num(inv.prefixes)],
              [t('IP addresses'), num(inv.ip_addresses)],
              [t('API tokens'), num(inv.api_tokens)],
              [t('Webhooks'), num(inv.webhooks)],
              [t('Change log entries'), num(inv.audit_entries)],
            ]}
          />
        </StatusCard>
        <StatusCard title={t('Password policy')} state={settings.expired_users ? 'warn' : undefined}>
          <Rows
            align="end"
            rows={[
              [t('Minimum length'), String(p.min_length)],
              [t('Letters'), lettersText(p.letters)],
              [t('Digits required'), yesNo(p.require_digits)],
              [t('Special characters required'), yesNo(p.require_special)],
              [t('Upper and lower case required'), yesNo(p.require_mixed_case)],
              [t('Password lifetime'), p.max_age_days ? t('{n} days', { n: p.max_age_days }) : t('Unlimited')],
              [t('Local accounts'), num(settings.local_users)],
              [t('Expired passwords'), settings.expired_users ? num(settings.expired_users) : undefined],
              [t('Expiring soon'), settings.expiring_users ? num(settings.expiring_users) : undefined],
            ]}
          />
        </StatusCard>
        <StatusCard title={t('Recent problems')} state={logState} wide>
          <p className="muted">
            {logs.recent.length === 0
              ? t('No warnings or errors since the start.')
              : t('Errors: {errors}, warnings: {warnings}. The last {n} are shown.', { errors: num(errors), warnings: num(warnings), n: logs.recent.length })}
          </p>
          {logs.recent.length > 0 && (
            <ul className="status-logs">
              {logs.recent.map((e, i) => (
                <li key={i}>
                  <div className="status-log-head">
                    <Pill state={e.level === 'error' ? 'error' : 'warn'} label={e.level === 'error' ? t('Error') : t('Warning')} />
                    <span className="muted">{formatDate(e.at, true)}</span>
                  </div>
                  <div className="status-log-msg">{e.message}</div>
                  {e.attrs && (
                    <div className="status-log-attrs">
                      {Object.entries(e.attrs).map(([k, v]) => (
                        <code key={k}>
                          {k}={v}
                        </code>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </StatusCard>
      </div>
    </>
  );
}
