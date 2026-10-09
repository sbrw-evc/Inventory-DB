import { useState } from 'react';
import { KeyRound, PlugZap, RefreshCw } from 'lucide-react';
import { Modal } from '../components/Modal';
import { getLang, t } from '../i18n';
import { formatDate } from '../lib/format';
import { settingsApi, type OpenBaoOverview, type OpenBaoReport, type OpenBaoStatus, type OpenBaoTarget, type SecretUsage } from './api';
import { ActionResult, Banner, Button, Card, Field, formatMs, Password, Pill, Rows, Switch, Table, useAction, useResource } from './ui';

export function baoState(s: OpenBaoStatus | undefined): 'ok' | 'warn' | 'error' | 'off' {
  if (!s || !s.configured) return 'off';
  if (!s.reachable || s.sealed || !s.token_ok || !s.mount_ok) return 'error';
  return s.last_error ? 'warn' : 'ok';
}

export function baoRows(s: OpenBaoStatus, locale: string): [string, string | undefined][] {
  return [
    [t('Address'), s.addr],
    [t('KV mount'), s.mount],
    [t('Namespace'), s.namespace],
    [t('Sign-in method'), s.auth === 'approle' ? 'AppRole' : s.auth ? t('Token') : undefined],
    [t('Server version'), s.version],
    [t('Cluster'), s.cluster_name],
    [t('Sealed'), s.reachable ? (s.sealed ? t('Yes') : t('No')) : undefined],
    [t('Token valid until'), s.token_expires ? formatDate(s.token_expires, true) : s.token_ok ? t('Does not expire') : undefined],
    [t('Policies'), s.policies?.join(', ')],
    [t('Response time'), s.reachable ? formatMs(s.latency_ms, locale) : undefined],
  ];
}

function usageText(u: SecretUsage) {
  return {
    integration: t('Integration signing secret'),
    ldap: t('LDAP / AD service account password'),
    entra: t('Entra ID client secret'),
    postgres: t('PostgreSQL password'),
    jwt: t('Session signing key'),
    other: t('Other'),
  }[u];
}

function Current({ overview, onChanged }: { overview: OpenBaoOverview; onChanged: () => void }) {
  const test = useAction();
  const move = useAction();
  const [report, setReport] = useState<OpenBaoReport | null>(null);
  const locale = getLang();
  const status = overview.status;
  const c = overview.connection;
  if (!overview.configured || !c || !status)
    return (
      <Card title={t('Secret store')} badge={<Pill state="warn" label={t('Not configured')} />}>
        <Banner kind="warn" title={t('OpenBao is not configured')}>
          {t('Secrets are kept encrypted in the database for now. Connect OpenBao below: all secrets will move there.')}
        </Banner>
        <Rows align="end" rows={[[t('Secrets in the database'), String(overview.local_secrets)]]} />
      </Card>
    );
  const runTest = () =>
    test.run(async () => {
      setReport(null);
      setReport(await settingsApi.testOpenBao());
    });
  const moveLocal = () =>
    move.run(async () => {
      const r = await settingsApi.moveLocalSecrets();
      onChanged();
      return t('{n} secrets moved to OpenBao.', { n: r.moved });
    });
  return (
    <Card
      title={t('Current OpenBao')}
      badge={<Pill state={baoState(status)} />}
      footer={
        <Button onClick={runTest} busy={test.busy}>
          {!test.busy && <PlugZap size={16} />}
          {t('Test connection')}
        </Button>
      }
    >
      <p className="muted">{t('All Inventory DB secrets are kept in OpenBao: directory passwords, integration keys, the database password and the session signing key.')}</p>
      <Rows
        align="end"
        rows={[
          ...baoRows(status, locale),
          [t('Settings from'), c.source === 'settings' ? t('the settings file') : t('the environment (OPENBAO_ADDR)')],
          [t('Certificate'), c.skip_verify ? t('Not checked') : c.custom_ca ? t('Own CA') : t('System CAs')],
          [t('Secrets stored'), String(overview.secrets)],
        ]}
      />
      {status.error && <Banner kind="error" title={status.error} />}
      {status.last_error && (
        <Banner kind="warn" title={t('Last error')}>
          {status.last_error}
          {status.last_error_at && ` · ${formatDate(status.last_error_at, true)}`}
        </Banner>
      )}
      {overview.list_error && <Banner kind="error" title={t('Secrets cannot be listed')}>{overview.list_error}</Banner>}
      {overview.local_secrets > 0 && (
        <Banner kind="warn" title={t('{n} secrets are still kept in the database', { n: overview.local_secrets })}>
          <div className="stack" style={{ gap: 8 }}>
            <p>{t('Move them to OpenBao; the database copies are removed.')}</p>
            <div>
              <Button onClick={moveLocal} busy={move.busy}>
                {t('Move to OpenBao')}
              </Button>
            </div>
          </div>
        </Banner>
      )}
      <ActionResult action={move} />
      {report &&
        (report.ok ? (
          <Banner kind={report.write_ok ? 'ok' : 'warn'} title={report.write_ok ? t('OpenBao works') : t('OpenBao answers, but writing fails')}>
            {report.write_ok ? t('Reading and writing secrets works.') : report.write_error}
          </Banner>
        ) : (
          <Banner kind="error" title={t('OpenBao does not answer')}>
            {report.error}
          </Banner>
        ))}
      <ActionResult action={test} />
    </Card>
  );
}

function Secrets({ epoch }: { epoch: number }) {
  const list = useResource(settingsApi.secrets, epoch);
  return (
    <Card
      title={t('Stored secrets')}
      badge={
        <button type="button" className="icon-btn" onClick={list.reload} aria-label={t('Refresh')} disabled={list.busy}>
          <RefreshCw size={16} className={list.busy ? 'spin' : undefined} />
        </button>
      }
    >
      <p className="muted">{t('Only names are shown here. Secret values never leave the server.')}</p>
      {list.error && <Banner kind="error" title={list.error.message} />}
      {list.data &&
        (list.data.length ? (
          <Table
            columns={[{ label: t('Path') }, { label: t('Purpose') }, { label: t('Keys') }]}
            rows={list.data.map((s) => ({
              key: s.path,
              cells: [
                <code key="p">{s.path}</code>,
                s.title ? `${usageText(s.usage)}: ${s.title}` : usageText(s.usage),
                s.keys.join(', '),
              ],
            }))}
          />
        ) : (
          <p className="muted">{t('No secrets yet.')}</p>
        ))}
    </Card>
  );
}

type Draft = Required<Omit<OpenBaoTarget, 'skip_verify' | 'auth'>> & { auth: 'token' | 'approle'; skip_verify: boolean };
const emptyDraft = (): Draft => ({ addr: '', mount: 'inventory', namespace: '', auth: 'approle', token: '', role_id: '', secret_id: '', approle_path: 'approle', ca_cert: '', skip_verify: false });

function Migration({ overview, onMoved }: { overview: OpenBaoOverview; onMoved: () => void }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [check, setCheck] = useState<{ key: string; report: OpenBaoReport } | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<{ addr: string; mount: string; copied: number } | null>(null);
  const action = useAction();
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const body = (): OpenBaoTarget => {
    const b: OpenBaoTarget = { addr: draft.addr.trim(), mount: draft.mount.trim() || 'inventory', auth: draft.auth, skip_verify: draft.skip_verify };
    if (draft.namespace.trim()) b.namespace = draft.namespace.trim();
    if (draft.ca_cert.trim()) b.ca_cert = draft.ca_cert.trim();
    if (draft.auth === 'token') b.token = draft.token.trim();
    else {
      b.role_id = draft.role_id.trim();
      b.secret_id = draft.secret_id.trim();
      b.approle_path = draft.approle_path.trim() || 'approle';
    }
    return b;
  };
  const key = JSON.stringify(body());
  const report = check && check.key === key ? check.report : null;
  const usable = !!report?.ok && report.write_ok;
  const occupied = (report?.secrets ?? 0) > 0;
  const ready = usable && (!occupied || overwrite);
  const complete = !!draft.addr.trim() && (draft.auth === 'token' ? !!draft.token.trim() : !!(draft.role_id.trim() && draft.secret_id.trim()));
  const first = !overview.configured;

  const runCheck = () =>
    action.run(async () => {
      setDone(null);
      setCheck({ key, report: await settingsApi.probeOpenBao(body()) });
      setOverwrite(false);
    });
  const migrate = () =>
    action.run(async () => {
      const r = await settingsApi.migrateOpenBao(body(), overwrite);
      setConfirming(false);
      setDone(r);
      setDraft(emptyDraft());
      setCheck(null);
      onMoved();
    });

  return (
    <Card title={first ? t('Connect OpenBao') : t('Move to another OpenBao')}>
      <p className="muted">
        {first
          ? t('Copy every secret into OpenBao and keep them there from now on. The connection is saved to the settings file.')
          : t('Copy every secret into another OpenBao and switch to it. The current OpenBao is not changed.')}
      </p>
      <div className="plain-fieldset">
        <div className="grid-3">
          <Field label={t('Address')}>{(id) => <input id={id} className="input" value={draft.addr} placeholder="https://openbao.example.com:8200" onChange={(e) => set({ addr: e.target.value })} spellCheck={false} />}</Field>
          <Field label={t('KV mount')}>{(id) => <input id={id} className="input" value={draft.mount} onChange={(e) => set({ mount: e.target.value })} spellCheck={false} />}</Field>
        </div>
        <div className="grid-2">
          <Field label={t('Namespace')} optional>
            {(id) => <input id={id} className="input" value={draft.namespace} onChange={(e) => set({ namespace: e.target.value })} spellCheck={false} />}
          </Field>
          <Field label={t('Sign-in method')}>
            {(id) => (
              <select id={id} className="input" value={draft.auth} onChange={(e) => set({ auth: e.target.value as Draft['auth'] })}>
                <option value="approle">AppRole</option>
                <option value="token">{t('Token')}</option>
              </select>
            )}
          </Field>
        </div>
        {draft.auth === 'token' ? (
          <Field label={t('Token')}>{(id) => <Password id={id} value={draft.token} onChange={(token) => set({ token })} autoComplete="off" />}</Field>
        ) : (
          <div className="grid-2">
            <Field label="Role ID">{(id) => <input id={id} className="input" value={draft.role_id} onChange={(e) => set({ role_id: e.target.value })} autoComplete="off" spellCheck={false} />}</Field>
            <Field label="Secret ID">{(id) => <Password id={id} value={draft.secret_id} onChange={(secret_id) => set({ secret_id })} autoComplete="off" />}</Field>
          </div>
        )}
        {draft.auth === 'approle' && (
          <Field label={t('AppRole mount')} optional>
            {(id) => <input id={id} className="input" value={draft.approle_path} onChange={(e) => set({ approle_path: e.target.value })} spellCheck={false} />}
          </Field>
        )}
        <Field label={t('CA certificate (PEM)')} optional hint={t('Needed when OpenBao uses a certificate from your own CA.')}>
          {(id) => <textarea id={id} className="input" value={draft.ca_cert} onChange={(e) => set({ ca_cert: e.target.value })} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" />}
        </Field>
        <Switch checked={draft.skip_verify} onChange={(skip_verify) => set({ skip_verify })} label={t('Do not check the certificate')} hint={t('Only for testing: the connection can be intercepted.')} />
      </div>
      {check && !report && <Banner kind="info" title={t('Settings changed after the check. Check the connection again.')} />}
      {report &&
        (report.ok ? (
          <>
            <Banner kind={usable ? 'ok' : 'error'} title={usable ? t('OpenBao answers') : t('OpenBao answers, but writing fails')}>
              {usable ? t('Signed in, the KV mount can be read and written.') : report.write_error}
            </Banner>
            {occupied && (
              <Banner kind="warn" title={t('The mount already holds {n} secrets.', { n: report.secrets ?? 0 })}>
                <div className="stack" style={{ gap: 8 }}>
                  <p>{t('Secrets with the same paths will be replaced.')}</p>
                  <Switch checked={overwrite} onChange={setOverwrite} label={t('Replace the secrets in that mount')} />
                </div>
              </Banner>
            )}
          </>
        ) : (
          <Banner kind="error" title={t('OpenBao does not answer')}>
            {report.error}
          </Banner>
        ))}
      {done && (
        <Banner kind="ok" title={t('Secrets are now kept in {addr} ({mount})', { addr: done.addr, mount: done.mount })}>
          {t('{n} secrets were copied.', { n: done.copied })}
        </Banner>
      )}
      <ActionResult action={action} />
      <div className="card-actions">
        <Button onClick={runCheck} busy={action.busy && !confirming} disabled={!complete}>
          {t('Check')}
        </Button>
        <Button
          variant="primary"
          disabled={!ready || action.busy}
          onClick={() => {
            action.clear();
            setConfirming(true);
          }}
        >
          {!action.busy && <KeyRound size={16} />}
          {first ? t('Connect') : t('Move')}
        </Button>
      </div>
      {confirming && (
        <Modal
          title={first ? t('Move all secrets to OpenBao?') : t('Move all secrets to another OpenBao?')}
          onClose={() => !action.busy && setConfirming(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={action.busy}>
                {t('Cancel')}
              </Button>
              <Button variant="primary" onClick={migrate} busy={action.busy}>
                {first ? t('Connect') : t('Move')}
              </Button>
            </>
          }
        >
          <ol className="conn-list">
            <li>{t('Every secret is copied to {addr} ({mount}).', { addr: draft.addr.trim(), mount: draft.mount.trim() || 'inventory' })}</li>
            <li>{t('The connection is saved to the settings file and used from now on, also after a restart.')}</li>
            {first ? <li>{t('The copies in the database are removed.')}</li> : <li>{t('The current OpenBao is left as it is.')}</li>}
          </ol>
          {occupied && <Banner kind="warn" title={t('Secrets with the same paths will be replaced.')} />}
          {action.error && <Banner kind="error" title={action.error.message} />}
        </Modal>
      )}
    </Card>
  );
}

/** Secret store: current OpenBao, the stored secrets and moving to another OpenBao (Umbrella's OpenBao settings page). */
export function OpenBaoPage() {
  const [epoch, setEpoch] = useState(0);
  const overview = useResource(settingsApi.openbao, epoch);
  const bump = () => setEpoch((e) => e + 1);
  if (!overview.data) return overview.error ? <Banner kind="error" title={overview.error.message} /> : <p className="muted">{t('Loading…')}</p>;
  return (
    <div className="settings-stack">
      <Current overview={overview.data} onChanged={bump} />
      {overview.data.configured && <Secrets epoch={epoch} />}
      <Migration overview={overview.data} onMoved={bump} />
    </div>
  );
}
