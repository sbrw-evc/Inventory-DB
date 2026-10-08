import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { AuditEntry, Column, RecordData, Table } from '@shared';
import { isReadOnlyType } from '@shared';
import { dataApi, platformApi } from '../api/endpoints';
import { qk } from '../api/hooks';
import { FieldInput } from '../cells/FieldInput';
import { t } from '../i18n';
import { useAuth } from '../lib/auth';
import { recordTitle, useBaseData } from '../lib/baseContext';
import { formatValue, relativeTime } from '../lib/format';
import { useRecordMutations } from '../lib/records';
import { toastError } from '../lib/toast';
import type { ResolvedColumn } from '../lib/viewColumns';
import { confirmDialog } from './dialogs';
import { FieldIcon, Icon } from './Icon';
import { Modal } from './Modal';

interface Props {
  table: Table;
  /** null → create a new record. */
  recordId: number | null;
  /** Column order/visibility from the current view; hidden ones go in a collapsible section. */
  resolved?: ResolvedColumn[];
  /** Pre-filled values for a new record (e.g. kanban stack, calendar day). */
  defaults?: Record<string, unknown>;
  /** Row data already loaded (public pages can't fetch single records). */
  initialRow?: RecordData;
  onClose: () => void;
  onCreated?: (row: RecordData) => void;
}

function Comments({ table, recordId }: { table: Table; recordId: number }) {
  const { perms } = useBaseData();
  const { user } = useAuth();
  const qc = useQueryClient();
  const comments = useQuery({ queryKey: qk.comments(table.id, recordId), queryFn: () => platformApi.listComments(table.id, recordId) });
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const post = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await platformApi.addComment(table.id, recordId, body.trim());
      setBody('');
      await qc.invalidateQueries({ queryKey: qk.comments(table.id, recordId) });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="comments">
      {comments.isLoading && <div className="empty-hint">{t('Loading…')}</div>}
      {comments.data && !comments.data.length && <div className="empty-hint">{t('No comments yet')}</div>}
      {comments.data?.map((c) => (
        <div key={c.id} className="comment">
          <div className="avatar">{(c.userName || '?').slice(0, 1).toUpperCase()}</div>
          <div className="comment-main">
            <div className="comment-head">
              <b>{c.userName}</b> <span className="muted small">{relativeTime(c.createdAt)}</span>
              {(c.userId === user?.id || perms.isOwner) && (
                <button
                  className="icon-btn comment-delete"
                  title={t('Delete')}
                  onClick={async () => {
                    try {
                      await platformApi.deleteComment(c.id);
                      await qc.invalidateQueries({ queryKey: qk.comments(table.id, recordId) });
                    } catch (e) {
                      toastError(e);
                    }
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              )}
            </div>
            <div className="comment-body">{c.body}</div>
          </div>
        </div>
      ))}
      {perms.canComment && (
        <div className="comment-compose">
          <textarea
            className="input"
            rows={2}
            placeholder={t('Write a comment…')}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post();
            }}
          />
          <button className="btn btn-primary btn-sm" onClick={post} disabled={busy || !body.trim()}>
            {t('Comment')}
          </button>
        </div>
      )}
    </div>
  );
}

function auditSummary(entry: AuditEntry, table: Table): Array<{ field: string; from: string; to: string }> {
  if (entry.action !== 'update' || !entry.details || typeof entry.details !== 'object') return [];
  return Object.entries(entry.details as Record<string, { from?: unknown; to?: unknown }>).map(([colId, ch]) => {
    const col = table.columns.find((c) => c.id === colId);
    const fmt = (v: unknown) => (col ? formatValue(col, v) : v === null || v === undefined ? '' : JSON.stringify(v));
    return { field: col?.title ?? colId, from: fmt(ch?.from), to: fmt(ch?.to) };
  });
}

const ACTION_LABELS: Record<AuditEntry['action'], string> = {
  insert: 'created the record',
  update: 'updated',
  delete: 'deleted the record',
  link: 'linked records',
  unlink: 'unlinked records',
  meta: 'changed the schema',
  import: 'imported data',
};

function History({ table, recordId }: { table: Table; recordId: number }) {
  const audit = useQuery({ queryKey: qk.recordAudit(table.id, recordId), queryFn: () => platformApi.recordAudit(table.id, recordId) });
  return (
    <div className="history">
      {audit.isLoading && <div className="empty-hint">{t('Loading…')}</div>}
      {audit.data && !audit.data.length && <div className="empty-hint">{t('No history yet')}</div>}
      {audit.data?.map((a) => (
        <div key={a.id} className="history-item">
          <div className="history-head">
            <b>{a.userName ?? t('System')}</b> {t(ACTION_LABELS[a.action] ?? a.action)}
            <span className="muted small"> · {relativeTime(a.createdAt)}</span>
          </div>
          {auditSummary(a, table).map((ch, i) => (
            <div key={i} className="history-change">
              <span className="history-field">{ch.field}</span>
              <span className="history-from">{ch.from || '∅'}</span>
              <Icon name="arrowRight" size={12} />
              <span className="history-to">{ch.to || '∅'}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function FieldRow({ column, children }: { column: Column; children: React.ReactNode }) {
  return (
    <div className="record-field">
      <label className="record-field-label">
        <FieldIcon type={column.type} />
        {column.title}
        {column.required && <span className="required-mark">*</span>}
      </label>
      {column.description && <div className="muted small">{column.description}</div>}
      <div className="record-field-input">{children}</div>
    </div>
  );
}

/** Right-docked record panel: all fields editable, plus Comments and History tabs. */
export function ExpandedRecord({ table, recordId, resolved, defaults, initialRow, onClose, onCreated }: Props) {
  const { perms, isPublic } = useBaseData();
  const [currentId, setCurrentId] = useState<number | null>(recordId);
  const [tab, setTab] = useState<'details' | 'comments' | 'history'>('details');
  const [draft, setDraft] = useState<Record<string, unknown>>(defaults ?? {});
  const [showHidden, setShowHidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const muts = useRecordMutations(table.id);
  const isNew = currentId === null;

  const record = useQuery({
    queryKey: qk.record(table.id, currentId ?? 0),
    queryFn: () => dataApi.get(table.id, currentId!),
    enabled: !isNew && !isPublic,
    initialData: initialRow,
  });
  const row: Record<string, unknown> = isNew ? draft : record.data ?? {};

  const ordered = useMemo(() => {
    const base = resolved ?? table.columns.map((column) => ({ column, show: true, width: 0 }));
    const known = new Set(base.map((r) => r.column.id));
    const extra = table.columns.filter((c) => !known.has(c.id)).map((column) => ({ column, show: false, width: 0 }));
    return [...base, ...extra].filter((r) => !(isNew && isReadOnlyType(r.column.type) && r.column.type !== 'Links'));
  }, [resolved, table.columns, isNew]);
  const shown = ordered.filter((r) => r.show || r.column.primary);
  const hidden = ordered.filter((r) => !r.show && !r.column.primary);

  const setValue = (column: Column, value: unknown) => {
    if (isNew) setDraft((d) => ({ ...d, [column.id]: value }));
    else if (currentId !== null) void muts.updateCell(currentId, column.id, value, row[column.id]);
  };

  const create = async () => {
    const missing = table.columns.filter((c) => c.required && !isReadOnlyType(c.type) && (draft[c.id] === undefined || draft[c.id] === null || draft[c.id] === ''));
    if (missing.length) {
      toastError(new Error(t('Please fill in: {fields}', { fields: missing.map((c) => c.title).join(', ') })));
      return;
    }
    setSaving(true);
    const created = await muts.createRecord(draft);
    setSaving(false);
    if (created) {
      setCurrentId(created.id);
      onCreated?.(created);
    }
  };

  const remove = async () => {
    if (currentId === null) return;
    const ok = await confirmDialog({ title: t('Delete this record?'), message: t('This can’t be undone.'), confirmLabel: t('Delete'), danger: true });
    if (ok && (await muts.deleteRecords([currentId]))) onClose();
  };

  const title = isNew ? t('New record in {table}', { table: table.title }) : recordTitle(table, row);
  const renderField = (r: { column: Column }) => (
    <FieldRow key={r.column.id} column={r.column}>
      <FieldInput
        column={r.column}
        value={row[r.column.id]}
        onChange={(v) => setValue(r.column, v)}
        readOnly={!perms.canEdit}
        table={table}
        recordId={currentId ?? undefined}
      />
    </FieldRow>
  );

  return (
    <Modal
      variant="drawer"
      width={560}
      onClose={onClose}
      title={
        <span className="record-title">
          <span className="muted small">{table.title}</span>
          <span>{title}</span>
        </span>
      }
      footer={
        <>
          {!isNew && perms.canEdit && (
            <button className="btn btn-danger-outline" onClick={remove}>
              <Icon name="trash" size={13} /> {t('Delete')}
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t('Close')}
          </button>
          {isNew && perms.canEdit && (
            <button className="btn btn-primary" onClick={create} disabled={saving}>
              {saving ? t('Saving…') : t('Save record')}
            </button>
          )}
        </>
      }
    >
      {!isNew && !isPublic && (
        <div className="tabs">
          <button className={`tab ${tab === 'details' ? 'active' : ''}`} onClick={() => setTab('details')}>
            {t('Details')}
          </button>
          <button className={`tab ${tab === 'comments' ? 'active' : ''}`} onClick={() => setTab('comments')}>
            <Icon name="comment" size={13} /> {t('Comments')}
          </button>
          <button className={`tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
            <Icon name="history" size={13} /> {t('History')}
          </button>
        </div>
      )}
      {tab === 'details' && (
        <div className="record-fields">
          {!isNew && record.isLoading && <div className="empty-hint">{t('Loading…')}</div>}
          {record.isError && <div className="notice notice-error">{(record.error as Error).message}</div>}
          {shown.map(renderField)}
          {hidden.length > 0 && (
            <>
              <button className="link-btn hidden-toggle" onClick={() => setShowHidden((s) => !s)}>
                <Icon name={showHidden ? 'chevronDown' : 'chevronRight'} size={13} />
                {showHidden ? t('Hide {n} hidden fields', { n: hidden.length }) : t('Show {n} hidden fields', { n: hidden.length })}
              </button>
              {showHidden && hidden.map(renderField)}
            </>
          )}
        </div>
      )}
      {tab === 'comments' && currentId !== null && <Comments table={table} recordId={currentId} />}
      {tab === 'history' && currentId !== null && <History table={table} recordId={currentId} />}
    </Modal>
  );
}
