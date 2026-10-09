import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { migrateApi, type MigrationResult } from '../api/endpoints';
import { qk } from '../api/hooks';
import { t } from '../i18n';
import { Icon } from './Icon';
import { Modal } from './Modal';

function skippedText(s: unknown): string {
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object') {
    const o = s as Record<string, unknown>;
    const parts = [o.table, o.column ?? o.field ?? o.view, o.type].filter(Boolean).map(String);
    const reason = o.reason ?? o.message;
    return `${parts.join(' · ')}${reason ? ` — ${String(reason)}` : ''}` || JSON.stringify(s);
  }
  return String(s);
}

/** Migrate a base from NocoDB: connect → pick a base → background job with progress, log and skipped items. */
export function MigrateDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [url, setUrl] = useState('https://app.nocodb.com');
  const [token, setToken] = useState('');
  const [nocoBases, setNocoBases] = useState<Array<{ id: string; title: string }> | null>(null);
  const [pick, setPick] = useState('');
  const [targetTitle, setTargetTitle] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => migrateApi.job(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'done' || q.state.data.status === 'failed') ? false : 1000),
  });
  const status = job.data?.status;
  const result = (job.data?.result ?? null) as MigrationResult | null;

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job.data?.log.length]);
  useEffect(() => {
    if (status === 'done') void qc.invalidateQueries({ queryKey: qk.bases });
  }, [status, qc]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await migrateApi.listNocoBases({ url: url.trim().replace(/\/+$/, ''), token: token.trim() });
      setNocoBases(list);
      if (list[0]) {
        setPick(list[0].id);
        setTargetTitle(list[0].title);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const j = await migrateApi.start({
        url: url.trim().replace(/\/+$/, ''),
        token: token.trim(),
        nocoBaseId: pick,
        targetTitle: targetTitle.trim() || undefined,
      });
      setJobId(j.id);
      qc.setQueryData(['job', j.id], j);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const step = jobId ? 3 : nocoBases ? 2 : 1;
  return (
    <Modal title={<><Icon name="migrate" /> {t('Migrate from NocoDB')}</>} onClose={onClose} width={640}>
      <ol className="steps">
        <li className={step >= 1 ? 'active' : ''}>{t('Connect')}</li>
        <li className={step >= 2 ? 'active' : ''}>{t('Choose base')}</li>
        <li className={step >= 3 ? 'active' : ''}>{t('Migrate')}</li>
      </ol>

      {step === 1 && (
        <div className="form-grid">
          <p className="muted">
            {t('Copies tables, fields, select options, records, links and views from a NocoDB instance (cloud or self-hosted). Create an API token in NocoDB under Account → Tokens.')}
          </p>
          <label className="field-label">{t('NocoDB URL')}</label>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.nocodb.com" />
          <label className="field-label">{t('API token')}</label>
          <input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="xc-token" />
          <div className="modal-actions">
            <span className="spacer" />
            <button className="btn btn-primary" onClick={connect} disabled={busy || !url.trim() || !token.trim()}>
              {busy ? t('Connecting…') : t('Connect')}
            </button>
          </div>
        </div>
      )}

      {step === 2 && nocoBases && (
        <div className="form-grid">
          {!nocoBases.length && <div className="notice">{t('No bases found for this token.')}</div>}
          <div className="noco-bases">
            {nocoBases.map((b) => (
              <label key={b.id} className={`noco-base ${pick === b.id ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="nocobase"
                  checked={pick === b.id}
                  onChange={() => {
                    setPick(b.id);
                    setTargetTitle(b.title);
                  }}
                />
                <Icon name="database" size={16} /> {b.title}
                <span className="muted small mono">{b.id}</span>
              </label>
            ))}
          </div>
          <label className="field-label">{t('New base name')}</label>
          <input className="input" value={targetTitle} onChange={(e) => setTargetTitle(e.target.value)} />
          <div className="modal-actions">
            <button className="btn" onClick={() => setNocoBases(null)}>
              {t('Back')}
            </button>
            <span className="spacer" />
            <button className="btn btn-primary" onClick={start} disabled={busy || !pick}>
              {t('Start migration')}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="migration-progress">
          <div className="row-flex">
            <span className={`status-chip ${status === 'done' ? 'ok' : status === 'failed' ? 'critical' : 'info'}`}>{t(status ?? 'queued')}</span>
            <span>{job.data?.message}</span>
          </div>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${Math.round((job.data?.progress ?? 0) * 100)}%` }} />
          </div>
          <pre ref={logRef} className="code-block job-log">
            {(job.data?.log ?? []).join('\n') || t('Waiting for the job to start…')}
          </pre>
          {result?.skipped && result.skipped.length > 0 && (
            <details className="skipped" open>
              <summary>{t('Skipped items ({n})', { n: result.skipped.length })}</summary>
              <ul>
                {result.skipped.map((s, i) => (
                  <li key={i}>{skippedText(s)}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="modal-actions">
            <span className="spacer" />
            {status === 'done' && result?.baseId ? (
              <button
                className="btn btn-primary"
                onClick={() => {
                  onClose();
                  navigate(`/base/${result.baseId}`);
                }}
              >
                {t('Open the new base')}
              </button>
            ) : (
              <button className="btn" onClick={onClose}>
                {status === 'failed' ? t('Close') : t('Run in background')}
              </button>
            )}
          </div>
        </div>
      )}
      {error && <div className="notice notice-error">{error}</div>}
    </Modal>
  );
}
