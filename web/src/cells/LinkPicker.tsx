import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Column, RecordData, Table } from '@shared';
import { dataApi } from '../api/endpoints';
import { qk } from '../api/hooks';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { t } from '../i18n';
import { findTable, primaryColumn, recordTitle, useBaseData } from '../lib/baseContext';
import { formatValue } from '../lib/format';
import { toastError } from '../lib/toast';
import { useDebounced } from '../lib/useDebounced';

interface Props {
  table: Table;
  column: Column;
  recordId: number;
  onClose: () => void;
  readOnly?: boolean;
}

/** Shows records linked through a Links column and lets editors link/unlink records of the related table. */
export function LinkPicker({ table, column, recordId, onClose, readOnly }: Props) {
  const { tables } = useBaseData();
  const qc = useQueryClient();
  const related = findTable(tables, column.options.relatedTableId);
  const [tab, setTab] = useState<'linked' | 'add'>('linked');
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 250);
  const [busy, setBusy] = useState<number | null>(null);

  const linked = useQuery({
    queryKey: [...qk.links(table.id, recordId, column.id), debounced],
    queryFn: () => dataApi.listLinks(table.id, recordId, column.id, { limit: 100, search: debounced }),
    placeholderData: keepPreviousData,
  });
  const candidates = useQuery({
    queryKey: ['linkCandidates', related?.id, debounced],
    queryFn: () => dataApi.list(related!.id, { limit: 50, search: debounced }),
    enabled: !!related && tab === 'add',
    placeholderData: keepPreviousData,
  });

  const linkedIds = new Set((linked.data?.list ?? []).map((r) => r.id));

  const afterChange = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: qk.links(table.id, recordId, column.id) }),
      qc.invalidateQueries({ queryKey: qk.records(table.id) }),
      qc.invalidateQueries({ queryKey: qk.record(table.id, recordId) }),
      related ? qc.invalidateQueries({ queryKey: qk.records(related.id) }) : undefined,
    ]);
  };

  const toggle = async (row: RecordData) => {
    setBusy(row.id);
    try {
      if (linkedIds.has(row.id)) await dataApi.unlink(table.id, recordId, column.id, [row.id]);
      else await dataApi.link(table.id, recordId, column.id, [row.id]);
      await afterChange();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };

  const pc = primaryColumn(related);
  const extraCols = (related?.columns ?? []).filter((c) => !c.primary && c.type !== 'ID' && c.type !== 'Links').slice(0, 3);
  const rows = tab === 'linked' ? linked.data?.list ?? [] : candidates.data?.list ?? [];
  const loading = tab === 'linked' ? linked.isLoading : candidates.isLoading;

  return (
    <Modal
      title={
        <span className="row-flex">
          <Icon name="link" /> {column.title}
          {related && <span className="muted"> → {related.title}</span>}
        </span>
      }
      onClose={onClose}
      width={620}
    >
      <div className="tabs">
        <button className={`tab ${tab === 'linked' ? 'active' : ''}`} onClick={() => setTab('linked')}>
          {t('Linked records')} {linked.data ? `(${linked.data.pageInfo.totalRows})` : ''}
        </button>
        {!readOnly && (
          <button className={`tab ${tab === 'add' ? 'active' : ''}`} onClick={() => setTab('add')}>
            <Icon name="plus" size={13} /> {t('Link records')}
          </button>
        )}
      </div>
      <div className="search-input">
        <Icon name="search" size={14} />
        <input
          className="input"
          autoFocus
          placeholder={t('Search {table}', { table: related?.title ?? '' })}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="link-list">
        {loading && <div className="empty-hint">{t('Loading…')}</div>}
        {!loading && !rows.length && (
          <div className="empty-hint">{tab === 'linked' ? t('No linked records yet') : t('No records found')}</div>
        )}
        {rows.map((row) => {
          const isLinked = linkedIds.has(row.id);
          return (
            <div key={row.id} className={`link-row ${isLinked ? 'linked' : ''}`}>
              <div className="link-row-main">
                <div className="link-row-title">{recordTitle(related, row)}</div>
                <div className="link-row-fields">
                  {extraCols.map((c) => {
                    const v = formatValue(c, row[c.id]);
                    return v ? (
                      <span key={c.id}>
                        <span className="muted">{c.title}:</span> {v}
                      </span>
                    ) : null;
                  })}
                </div>
              </div>
              {!readOnly && (
                <button
                  className={`btn btn-sm ${isLinked ? '' : 'btn-primary'}`}
                  disabled={busy === row.id}
                  onClick={() => toggle(row)}
                >
                  {isLinked ? t('Unlink') : t('Link')}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {!pc && <p className="muted small">{t('The related table is not available.')}</p>}
    </Modal>
  );
}
