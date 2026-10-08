import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Table, Webhook, WebhookEvent } from '@shared';
import { platformApi, type WebhookInput } from '../api/endpoints';
import { qk } from '../api/hooks';
import { t } from '../i18n';
import { relativeTime } from '../lib/format';
import { toast, toastError } from '../lib/toast';
import { confirmDialog } from './dialogs';
import { Icon } from './Icon';
import { Modal } from './Modal';

const EVENTS: Array<{ v: WebhookEvent; label: string }> = [
  { v: 'after.insert', label: 'After insert' },
  { v: 'after.update', label: 'After update' },
  { v: 'after.delete', label: 'After delete' },
];

const blank = (table: Table): WebhookInput => ({
  title: `${table.title} webhook`,
  event: 'after.insert',
  url: '',
  method: 'POST',
  headers: {},
  active: true,
  condition: null,
});

function HookForm({ initial, onSave, onCancel }: { initial: WebhookInput; onSave: (h: WebhookInput) => Promise<void>; onCancel: () => void }) {
  const [h, setH] = useState(initial);
  const [headers, setHeaders] = useState<Array<[string, string]>>(Object.entries(initial.headers ?? {}));
  const [busy, setBusy] = useState(false);
  const valid = h.title.trim() && /^https?:\/\//i.test(h.url.trim());
  return (
    <div className="form-grid">
      <label className="field-label">{t('Title')}</label>
      <input className="input" value={h.title} onChange={(e) => setH({ ...h, title: e.target.value })} />
      <label className="field-label">{t('Event')}</label>
      <select className="input" value={h.event} onChange={(e) => setH({ ...h, event: e.target.value as WebhookEvent })}>
        {EVENTS.map((ev) => (
          <option key={ev.v} value={ev.v}>
            {t(ev.label)}
          </option>
        ))}
      </select>
      <label className="field-label">{t('Request')}</label>
      <div className="row-flex">
        <select className="input" style={{ width: 100 }} value={h.method} onChange={(e) => setH({ ...h, method: e.target.value as Webhook['method'] })}>
          <option>POST</option>
          <option>PUT</option>
          <option>PATCH</option>
        </select>
        <input className="input" placeholder="https://example.com/hook" value={h.url} onChange={(e) => setH({ ...h, url: e.target.value })} />
      </div>
      <label className="field-label">{t('Headers')}</label>
      <div className="headers-editor">
        {headers.map(([k, v], i) => (
          <div key={i} className="row-flex">
            <input className="input input-sm" placeholder={t('Name')} value={k} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
            <input className="input input-sm" placeholder={t('Value')} value={v} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
            <button className="icon-btn" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
        <button className="link-btn" onClick={() => setHeaders([...headers, ['', '']])}>
          <Icon name="plus" size={13} /> {t('Add header')}
        </button>
      </div>
      <label className="checkbox-label">
        <input type="checkbox" checked={h.active} onChange={(e) => setH({ ...h, active: e.target.checked })} /> {t('Active')}
      </label>
      <div className="modal-actions">
        <span className="spacer" />
        <button className="btn" onClick={onCancel}>
          {t('Cancel')}
        </button>
        <button
          className="btn btn-primary"
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave({ ...h, title: h.title.trim(), url: h.url.trim(), headers: Object.fromEntries(headers.filter(([k]) => k.trim())) });
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('Save webhook')}
        </button>
      </div>
    </div>
  );
}

function HookLogs({ hook }: { hook: Webhook }) {
  const logs = useQuery({ queryKey: qk.hookLogs(hook.id), queryFn: () => platformApi.hookLogs(hook.id) });
  return (
    <div className="hook-logs">
      <div className="row-flex">
        <b>{t('Delivery log')}</b>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => logs.refetch()} title={t('Refresh')}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {logs.isLoading && <div className="empty-hint">{t('Loading…')}</div>}
      {logs.data && !logs.data.length && <div className="empty-hint">{t('No deliveries yet')}</div>}
      {logs.data?.map((l) => (
        <details key={l.id} className="hook-log">
          <summary>
            <span className={`status-chip ${l.status && l.status < 300 ? 'ok' : 'critical'}`}>{l.status ?? t('error')}</span>
            <span>{l.event}</span>
            <span className="muted small">{relativeTime(l.createdAt)}</span>
            {l.error && <span className="error-text small">{l.error}</span>}
          </summary>
          <pre className="code-block">{JSON.stringify(l.payload, null, 2)}</pre>
          {l.response && <pre className="code-block">{l.response}</pre>}
        </details>
      ))}
    </div>
  );
}

/** Webhook list / create / edit / test / logs for one table. */
export function WebhooksDialog({ table, onClose }: { table: Table; onClose: () => void }) {
  const qc = useQueryClient();
  const hooks = useQuery({ queryKey: qk.hooks(table.id), queryFn: () => platformApi.listHooks(table.id) });
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.hooks(table.id) });

  const save = async (input: WebhookInput) => {
    try {
      if (editing === 'new') await platformApi.createHook(table.id, input);
      else if (editing) await platformApi.updateHook(editing.id, input);
      await refresh();
      setEditing(null);
      toast(t('Webhook saved'), 'success');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Modal title={<><Icon name="webhook" /> {t('Webhooks · {table}', { table: table.title })}</>} onClose={onClose} width={640}>
      {editing ? (
        <HookForm
          initial={editing === 'new' ? blank(table) : { ...editing }}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <>
          <div className="row-flex">
            <span className="muted">{t('Send an HTTP request when records change.')}</span>
            <span className="spacer" />
            <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
              <Icon name="plus" size={13} /> {t('New webhook')}
            </button>
          </div>
          {hooks.isLoading && <div className="empty-hint">{t('Loading…')}</div>}
          {hooks.data && !hooks.data.length && <div className="empty-state-sm">{t('No webhooks yet')}</div>}
          <div className="hook-list">
            {hooks.data?.map((h) => (
              <div key={h.id} className="hook-item">
                <div className="hook-item-main">
                  <div className="row-flex">
                    <span className={`status-dot ${h.active ? 'on' : ''}`} />
                    <b>{h.title}</b>
                    <span className="status-chip info">{h.event}</span>
                  </div>
                  <div className="muted small mono">
                    {h.method} {h.url}
                  </div>
                </div>
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    try {
                      await platformApi.testHook(h.id);
                      toast(t('Test payload sent'), 'success');
                      void qc.invalidateQueries({ queryKey: qk.hookLogs(h.id) });
                      setLogsFor(h.id);
                    } catch (e) {
                      toastError(e);
                    }
                  }}
                >
                  <Icon name="play" size={12} /> {t('Test')}
                </button>
                <button className="btn btn-sm" onClick={() => setLogsFor(logsFor === h.id ? null : h.id)}>
                  {t('Logs')}
                </button>
                <button className="icon-btn" onClick={() => setEditing(h)} title={t('Edit')}>
                  <Icon name="edit" size={14} />
                </button>
                <button
                  className="icon-btn"
                  title={t('Delete')}
                  onClick={async () => {
                    if (!(await confirmDialog({ title: t('Delete webhook “{name}”?', { name: h.title }), danger: true, confirmLabel: t('Delete') }))) return;
                    try {
                      await platformApi.deleteHook(h.id);
                      await refresh();
                    } catch (e) {
                      toastError(e);
                    }
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
                {logsFor === h.id && (
                  <div className="hook-item-logs">
                    <HookLogs hook={h} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
