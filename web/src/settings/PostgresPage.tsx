import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PlugZap, RefreshCw } from 'lucide-react';
import { Modal } from '../components/Modal';
import { getLang, t } from '../i18n';
import { formatDate } from '../lib/format';
import { settingsApi, type DatabaseStats, type PgTarget, type PostgresOverview, type PostgresReport, type PostgresStats, type PostgresTest, type SslMode, type Statement } from './api';
import { ActionResult, Banner, Button, Card, Field, formatBytes, formatMs, formatPercent, Password, Rows, Switch, Table, useAction, useResource } from './ui';

const AUTO_REFRESH_MS = 10_000;
const SSL_MODES: SslMode[] = ['disable', 'require', 'verify-full'];

function sslText(m: SslMode) {
  return { disable: t('Off'), require: t('Encrypted, certificate not checked'), 'verify-full': t('Encrypted and verified') }[m];
}

function CurrentConnection({ overview }: { overview: PostgresOverview }) {
  const test = useAction();
  const [result, setResult] = useState<PostgresTest | null>(null);
  const locale = getLang();
  const c = overview.connection;
  const runTest = () =>
    test.run(async () => {
      setResult(null);
      setResult(await settingsApi.testPostgres());
    });
  const passwordIn = { openbao: 'OpenBao', file: t('the settings file'), environment: t('the environment (DATABASE_URL)') }[overview.password_in];
  return (
    <Card
      title={t('Current connection')}
      badge={<span className={`pill pill-${overview.ok ? 'ok' : 'error'}`}>{overview.ok ? t('Works') : t('Error')}</span>}
      footer={
        <Button onClick={runTest} busy={test.busy}>
          {!test.busy && <PlugZap size={16} />}
          {t('Test connection')}
        </Button>
      }
    >
      <p className="muted">{t('The PostgreSQL database where Inventory DB keeps all its data.')}</p>
      <Rows
        align="end"
        rows={[
          [t('Host'), c.host],
          [t('Port'), String(c.port)],
          [t('Database'), c.database],
          [t('Schema'), overview.info.schema],
          [t('User'), c.user],
          [t('SSL'), sslText(c.sslmode)],
          [t('Server version'), overview.info.version],
          [t('Database size'), formatBytes(overview.info.size_bytes, locale)],
          [t('Settings from'), overview.source === 'settings' ? t('the settings file') : t('the environment (DATABASE_URL)')],
          [t('Password kept in'), passwordIn],
        ]}
      />
      {overview.error && <Banner kind="error" title={overview.error} />}
      {result &&
        (result.ok ? (
          <Banner kind="ok" title={t('Connection works')}>
            {t('PostgreSQL {version} answered in {latency} ms.', { version: result.version ?? '?', latency: result.latency_ms })}
          </Banner>
        ) : (
          <Banner kind="error" title={t('PostgreSQL does not answer')}>
            {result.error}
          </Banner>
        ))}
      <ActionResult action={test} />
    </Card>
  );
}

function Tile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="pg-tile">
      <div className="pg-tile-label">{label}</div>
      <div className="pg-tile-value">{value}</div>
      {note && <div className="pg-tile-note">{note}</div>}
    </div>
  );
}

/** Transactions per second between two refreshes. */
function useRate(stats: PostgresStats | null) {
  const previous = useRef<PostgresStats | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    if (!stats) return;
    const prev = previous.current;
    previous.current = stats;
    if (!prev || prev.database.stats_reset !== stats.database.stats_reset) return setRate(null);
    const seconds = (Date.parse(stats.collected_at) - Date.parse(prev.collected_at)) / 1000;
    const delta = stats.database.xact_commit + stats.database.xact_rollback - prev.database.xact_commit - prev.database.xact_rollback;
    if (seconds > 0 && delta >= 0) setRate(delta / seconds);
  }, [stats]);
  return rate;
}

function Transactions({ db, rate }: { db: DatabaseStats; rate: number | null }) {
  const locale = getLang();
  const n = (v: number) => Math.round(v).toLocaleString(locale);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <h3 className="pg-sub">{t('Transactions')}</h3>
      <div className="pg-tiles">
        <Tile label={t('Commits')} value={n(db.xact_commit)} />
        <Tile label={t('Rollbacks')} value={n(db.xact_rollback)} note={formatPercent(db.xact_rollback, db.xact_commit + db.xact_rollback, locale)} />
        <Tile label={t('Transactions per second')} value={rate === null ? '—' : n(rate)} note={rate === null ? t('after the next refresh') : undefined} />
        <Tile label={t('Cache hit ratio')} value={formatPercent(db.blks_hit, db.blks_hit + db.blks_read, locale)} />
        <Tile label={t('Connections')} value={n(db.backends)} />
        <Tile label={t('Deadlocks')} value={n(db.deadlocks)} />
        <Tile label={t('Temporary files')} value={n(db.temp_files)} note={formatBytes(db.temp_bytes, locale)} />
        <Tile label={t('Rows inserted')} value={n(db.tup_inserted)} />
        <Tile label={t('Rows updated')} value={n(db.tup_updated)} />
        <Tile label={t('Rows deleted')} value={n(db.tup_deleted)} />
        <Tile label={t('Rows read')} value={n(db.tup_fetched)} />
      </div>
      <p className="hint">{db.stats_reset ? t('Counters since {at}.', { at: formatDate(db.stats_reset, true) }) : t('Counters since the statistics were last reset.')}</p>
    </div>
  );
}

function Statements({ stats }: { stats: PostgresStats['statements'] }) {
  const [order, setOrder] = useState<'total' | 'mean'>('total');
  const locale = getLang();
  const list: Statement[] = (order === 'total' ? stats.by_total : stats.by_mean) ?? [];
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="pg-sub-row">
        <h3 className="pg-sub">{t('Top 10 statements')}</h3>
        {stats.installed && !stats.error && (
          <div className="segmented" role="radiogroup" aria-label={t('Top 10 statements')}>
            {(['total', 'mean'] as const).map((o) => (
              <button key={o} type="button" role="radio" aria-checked={order === o} className={order === o ? 'active' : ''} onClick={() => setOrder(o)}>
                {o === 'total' ? t('By total time') : t('By mean time')}
              </button>
            ))}
          </div>
        )}
      </div>
      {!stats.installed ? (
        <Banner kind="info" title={t('The pg_stat_statements extension is not installed in this database.')}>
          {t('Add pg_stat_statements to shared_preload_libraries, restart PostgreSQL and run CREATE EXTENSION pg_stat_statements.')}
        </Banner>
      ) : stats.error ? (
        <Banner kind="warn" title={t('pg_stat_statements is not readable')}>
          {stats.error}
        </Banner>
      ) : list.length === 0 ? (
        <p className="muted">{t('No statements recorded yet.')}</p>
      ) : (
        <Table
          columns={[{ label: t('Query'), wide: true }, { label: t('Calls'), numeric: true }, { label: t('Total'), numeric: true }, { label: t('Mean'), numeric: true }, { label: t('Rows'), numeric: true }]}
          rows={list.map((s, i) => ({
            key: s.query_id || i,
            cells: [<code key="q" className="pg-query">{s.query}</code>, s.calls.toLocaleString(locale), formatMs(s.total_ms, locale), formatMs(s.mean_ms, locale), s.rows.toLocaleString(locale)],
          }))}
        />
      )}
    </div>
  );
}

function Statistics() {
  const stats = useResource(settingsApi.postgresStats);
  const [auto, setAuto] = useState(true);
  const rate = useRate(stats.data);
  const locale = getLang();
  const { reload } = stats;
  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(() => document.visibilityState === 'visible' && reload(), AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [auto, reload]);
  const s = stats.data;
  return (
    <Card
      title={t('Statistics')}
      badge={
        <Button onClick={reload} busy={stats.busy}>
          {!stats.busy && <RefreshCw size={16} />}
          {t('Refresh')}
        </Button>
      }
    >
      <p className="muted">{t('Live counters of the database from pg_stat_database, table sizes and the longest running operations.')}</p>
      <div className="pg-sub-row">
        <Switch checked={auto} onChange={setAuto} label={t('Refresh every 10 seconds')} />
        {s && <span className="hint">{t('Collected {at}', { at: formatDate(s.collected_at, true) })}</span>}
      </div>
      {stats.error && <Banner kind="error" title={stats.error.message} />}
      {s && (
        <>
          <Transactions db={s.database} rate={rate} />
          <div className="stack" style={{ gap: 10 }}>
            <h3 className="pg-sub">{t('Table sizes')}</h3>
            <Table
              columns={[{ label: t('Table'), wide: true }, { label: t('Total'), numeric: true }, { label: t('Data'), numeric: true }, { label: t('Indexes'), numeric: true }, { label: t('Rows'), numeric: true }, { label: t('Dead rows'), numeric: true }]}
              rows={s.tables.map((r) => ({
                key: `${r.schema}.${r.name}`,
                cells: [<code key="n">{r.name}</code>, formatBytes(r.total_bytes, locale), formatBytes(r.table_bytes, locale), formatBytes(r.index_bytes, locale), r.rows.toLocaleString(locale), r.dead_rows.toLocaleString(locale)],
              }))}
            />
            {s.table_count > s.tables.length && <p className="hint">{t('The {shown} largest of {total} tables.', { shown: s.tables.length, total: s.table_count })}</p>}
          </div>
          <div className="stack" style={{ gap: 10 }}>
            <h3 className="pg-sub">{t('Top 10 longest operations')}</h3>
            {!s.full_visibility && <Banner kind="info" title={t('Only sessions of the database user are visible. Grant the pg_read_all_stats role to see all sessions.')} />}
            {s.operations.length === 0 ? (
              <p className="muted">{t('No queries or open transactions are running right now.')}</p>
            ) : (
              <Table
                columns={[{ label: 'PID', numeric: true }, { label: t('User / application') }, { label: t('State') }, { label: t('Waiting for') }, { label: t('Duration'), numeric: true }, { label: t('Query'), wide: true }]}
                rows={s.operations.map((o) => ({
                  key: o.pid,
                  cells: [
                    o.pid,
                    <span key="w" className="pg-who">
                      <span>{o.user || o.backend_type}</span>
                      <span className="hint">{[o.application, o.client, o.database].filter(Boolean).join(' · ')}</span>
                    </span>,
                    o.state,
                    o.wait_event ? `${o.wait_event_type}: ${o.wait_event}` : '—',
                    formatMs(o.duration_ms, locale),
                    <code key="q" className="pg-query">
                      {o.query}
                      {o.truncated && '…'}
                    </code>,
                  ],
                }))}
              />
            )}
          </div>
          <Statements stats={s.statements} />
        </>
      )}
    </Card>
  );
}

const emptyTarget = (): PgTarget & { portText: string } => ({ host: '', port: 5432, portText: '5432', database: 'inventory', user: 'inventory', password: '', sslmode: 'disable' });

function Migration({ current, onMoved }: { current: PostgresOverview; onMoved: () => void }) {
  const [draft, setDraft] = useState(emptyTarget);
  const [check, setCheck] = useState<{ key: string; report: PostgresReport } | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<{ where: string; tables: number; rows: number } | null>(null);
  const action = useAction();
  const set = (patch: Partial<typeof draft>) => setDraft({ ...draft, ...patch });
  const body = (): PgTarget => ({ host: draft.host.trim(), port: Number(draft.portText) || 5432, database: draft.database.trim(), user: draft.user.trim(), password: draft.password, sslmode: draft.sslmode });
  const key = JSON.stringify(body());
  const report = check && check.key === key ? check.report : null;
  const probe = report?.ok ? report.probe : null;
  const usable = !!probe && (probe.can_create || probe.has_state);
  const ready = usable && (!probe!.has_state || overwrite);
  const complete = !!(draft.host.trim() && draft.database.trim() && draft.user.trim());
  const where = `${draft.user.trim()}@${draft.host.trim()}:${draft.portText}/${draft.database.trim()}`;

  const runCheck = () =>
    action.run(async () => {
      setDone(null);
      setCheck({ key, report: await settingsApi.probePostgres(body()) });
      setOverwrite(false);
    });
  const migrate = () =>
    action.run(async () => {
      const r = await settingsApi.migratePostgres(body(), overwrite);
      setConfirming(false);
      setDone(r);
      setDraft(emptyTarget());
      setCheck(null);
      onMoved();
    });

  return (
    <Card title={t('Move to another database')}>
      <p className="muted">
        {t('Copy all Inventory DB data to another PostgreSQL database and switch to it. The current database is not changed.')}{' '}
        {current.password_in === 'openbao' || current.source === 'environment' ? t('The new password is saved to OpenBao when it is configured.') : ''}
      </p>
      <div className="plain-fieldset">
        <div className="grid-3">
          <Field label={t('Host')}>{(id) => <input id={id} className="input" value={draft.host} placeholder="postgres.example.com" onChange={(e) => set({ host: e.target.value })} spellCheck={false} />}</Field>
          <Field label={t('Port')}>{(id) => <input id={id} className="input" value={draft.portText} inputMode="numeric" onChange={(e) => set({ portText: e.target.value.replace(/\D/g, '') })} />}</Field>
        </div>
        <div className="grid-2">
          <Field label={t('Database')}>{(id) => <input id={id} className="input" value={draft.database} onChange={(e) => set({ database: e.target.value })} spellCheck={false} />}</Field>
          <Field label={t('SSL')}>
            {(id) => (
              <select id={id} className="input" value={draft.sslmode} onChange={(e) => set({ sslmode: e.target.value as SslMode })}>
                {SSL_MODES.map((m) => (
                  <option key={m} value={m}>
                    {sslText(m)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <div className="grid-2">
          <Field label={t('User')}>{(id) => <input id={id} className="input" value={draft.user} onChange={(e) => set({ user: e.target.value })} autoComplete="off" spellCheck={false} />}</Field>
          <Field label={t('Password')}>{(id) => <Password id={id} value={draft.password} onChange={(password) => set({ password })} />}</Field>
        </div>
      </div>
      {check && !report && <Banner kind="info" title={t('Settings changed after the check. Check the connection again.')} />}
      {report &&
        (report.ok && probe ? (
          <>
            <Banner kind={usable ? 'ok' : 'error'} title={usable ? t('The database answers') : t('The database cannot be used')}>
              {t('PostgreSQL {version}, database {database}, user {user}.', { version: probe.version, database: probe.database, user: probe.user })}
              {!usable && <p>{t('The user may not create tables in that database.')}</p>}
            </Banner>
            {probe.has_state && (
              <Banner kind="warn" title={probe.saved_at ? t('The database already holds Inventory DB data (updated {at}).', { at: formatDate(probe.saved_at, true) }) : t('The database already holds Inventory DB data.')}>
                <div className="stack" style={{ gap: 8 }}>
                  <p>{t('Its tables will be replaced with the current data of this installation.')}</p>
                  <Switch checked={overwrite} onChange={setOverwrite} label={t('Replace the Inventory DB data in that database')} />
                </div>
              </Banner>
            )}
          </>
        ) : (
          <Banner kind="error" title={t('PostgreSQL does not answer')}>
            {report.error}
          </Banner>
        ))}
      {done && (
        <Banner kind="ok" title={t('Inventory DB now works with {where}', { where: done.where })}>
          {t('{tables} tables and {rows} rows were copied. The previous database was not changed and can be removed when it is no longer needed.', { tables: done.tables, rows: done.rows })}
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
          {t('Move')}
        </Button>
      </div>
      {confirming && (
        <Modal
          title={t('Move Inventory DB to another database?')}
          onClose={() => !action.busy && setConfirming(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={action.busy}>
                {t('Cancel')}
              </Button>
              <Button variant="primary" onClick={migrate} busy={action.busy}>
                {t('Move')}
              </Button>
            </>
          }
        >
          <ol className="conn-list">
            <li>{t('All tables, records, settings and the change log are copied to {where}.', { where })}</li>
            <li>{t('The password of the new database is saved to OpenBao (or to the settings file when OpenBao is not configured).')}</li>
            <li>{t('While the data is copied, Inventory DB does not answer requests.')}</li>
            <li>{t('The current database {current} is left as it is.', { current: current.where })}</li>
          </ol>
          {probe?.has_state && <Banner kind="warn" title={t('The Inventory DB data already stored in the new database will be replaced.')} />}
          {action.error && <Banner kind="error" title={action.error.message} />}
        </Modal>
      )}
    </Card>
  );
}

/** PostgreSQL connection, statistics and moving to another database (Umbrella's PostgreSQL settings page). */
export function PostgresPage() {
  const [epoch, setEpoch] = useState(0);
  const overview = useResource(settingsApi.postgres, epoch);
  if (!overview.data) return overview.error ? <Banner kind="error" title={overview.error.message} /> : <p className="muted">{t('Loading…')}</p>;
  return (
    <div className="settings-stack">
      <CurrentConnection overview={overview.data} />
      <Statistics />
      <Migration current={overview.data} onMoved={() => setEpoch((e) => e + 1)} />
    </div>
  );
}
