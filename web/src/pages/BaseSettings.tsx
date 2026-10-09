import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuditEntry, Role } from '@shared';
import { type BaseWithTables, platformApi } from '../api/endpoints';
import { qk } from '../api/hooks';
import { confirmDialog } from '../components/dialogs';
import { Icon } from '../components/Icon';
import { getLang, t } from '../i18n';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import { permissionsFor, ROLES } from '../lib/roles';
import { toast, toastError } from '../lib/toast';

const ROLE_CHIP: Record<Role, string> = { owner: 'ok', editor: 'info', commenter: 'warning', viewer: 'neutral' };

function Members({ base }: { base: BaseWithTables }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const perms = permissionsFor(base.role);
  const members = useQuery({ queryKey: qk.members(base.id), queryFn: () => platformApi.listMembers(base.id) });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.members(base.id) });

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await platformApi.inviteMember(base.id, { email: email.trim(), role });
      setEmail('');
      toast(t('Member added'), 'success');
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>{t('Members')}</h2>
      {perms.isOwner && (
        <form className="invite-row" onSubmit={invite}>
          <input className="input" type="email" required placeholder={t('Email of an existing user')} value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(r)}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={busy || !email.trim()}>
            {t('Invite')}
          </button>
        </form>
      )}
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('Name')}</th>
            <th>{t('Email')}</th>
            <th>{t('Role')}</th>
            {perms.isOwner && <th />}
          </tr>
        </thead>
        <tbody>
          {members.data?.map((m) => (
            <tr key={m.userId}>
              <td>
                {m.name} {m.userId === user?.id && <span className="muted small">({t('you')})</span>}
              </td>
              <td className="muted">{m.email}</td>
              <td>
                {perms.isOwner ? (
                  <select
                    className="input input-sm"
                    value={m.role}
                    onChange={async (e) => {
                      try {
                        await platformApi.updateMember(base.id, m.userId, e.target.value as Role);
                        await refresh();
                      } catch (err) {
                        toastError(err);
                      }
                    }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(r)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={`status-chip ${ROLE_CHIP[m.role]}`}>{t(m.role)}</span>
                )}
              </td>
              {perms.isOwner && (
                <td className="actions-cell">
                  <button
                    className="icon-btn"
                    title={t('Remove')}
                    onClick={async () => {
                      if (!(await confirmDialog({ title: t('Remove {name} from this base?', { name: m.name || m.email }), danger: true, confirmLabel: t('Remove') }))) return;
                      try {
                        await platformApi.removeMember(base.id, m.userId);
                        await refresh();
                      } catch (err) {
                        toastError(err);
                      }
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {members.isLoading && <div className="empty-hint">{t('Loading…')}</div>}
      <div className="role-legend muted small">
        <span className="status-chip ok">{t('owner')}</span> {t('manages members and the base')} ·{' '}
        <span className="status-chip info">{t('editor')}</span> {t('edits data, fields and views')} ·{' '}
        <span className="status-chip warning">{t('commenter')}</span> {t('reads and comments')} ·{' '}
        <span className="status-chip neutral">{t('viewer')}</span> {t('reads only')}
      </div>
    </section>
  );
}

const AUDIT_PAGE = 50;

function describe(a: AuditEntry, base: BaseWithTables): string {
  const table = base.tables.find((tb) => tb.id === a.tableId);
  const parts = [t(a.action)];
  if (table) parts.push(table.title);
  if (a.recordId) parts.push(`#${a.recordId}`);
  if (a.action === 'update' && a.details && typeof a.details === 'object') {
    const cols = Object.keys(a.details as object)
      .map((id) => table?.columns.find((c) => c.id === id)?.title ?? id)
      .join(', ');
    if (cols) parts.push(`(${cols})`);
  }
  return parts.join(' · ');
}

function AuditLog({ base }: { base: BaseWithTables }) {
  const audit = useInfiniteQuery({
    queryKey: qk.baseAudit(base.id),
    queryFn: ({ pageParam }) => platformApi.baseAudit(base.id, { offset: pageParam, limit: AUDIT_PAGE }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length < AUDIT_PAGE ? undefined : all.length * AUDIT_PAGE),
  });
  const rows = audit.data?.pages.flat() ?? [];
  return (
    <section className="settings-section">
      <h2>{t('Audit log')}</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('When')}</th>
            <th>{t('Who')}</th>
            <th>{t('What')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="muted nowrap" title={new Date(a.createdAt).toLocaleString(getLang())}>
                {relativeTime(a.createdAt)}
              </td>
              <td>{a.userName ?? t('System')}</td>
              <td>{describe(a, base)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {audit.isLoading && <div className="empty-hint">{t('Loading…')}</div>}
      {audit.isError && <div className="notice notice-error">{(audit.error as Error).message}</div>}
      {audit.data && !rows.length && <div className="empty-hint">{t('No activity yet')}</div>}
      {audit.hasNextPage && (
        <button className="btn" onClick={() => audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
          {t('Load more')}
        </button>
      )}
    </section>
  );
}

export function BaseSettings({ base }: { base: BaseWithTables }) {
  const perms = permissionsFor(base.role);
  const [tab, setTab] = useState<'members' | 'audit'>('members');
  return (
    <div className="page">
      <div className="page-head">
        <h1>
          <span className="base-dot" style={{ background: base.color || 'var(--accent)' }} /> {base.title}
        </h1>
        <span className={`status-chip ${ROLE_CHIP[perms.role]}`}>{t(perms.role)}</span>
      </div>
      <div className="tabs">
        <button className={`tab ${tab === 'members' ? 'active' : ''}`} onClick={() => setTab('members')}>
          <Icon name="users" size={14} /> {t('Members')}
        </button>
        {perms.isOwner && (
          <button className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
            <Icon name="history" size={14} /> {t('Audit log')}
          </button>
        )}
      </div>
      {tab === 'members' ? <Members base={base} /> : <AuditLog base={base} />}
    </div>
  );
}
