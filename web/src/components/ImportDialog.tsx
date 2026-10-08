import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Table } from '@shared';
import { type ImportSheetPreview, metaApi, platformApi } from '../api/endpoints';
import { qk, useBase, useBases } from '../api/hooks';
import { t } from '../i18n';
import { permissionsFor } from '../lib/roles';
import { toast } from '../lib/toast';
import { FIELD_LABELS, FieldIcon, Icon } from './Icon';
import { Modal } from './Modal';

interface Props {
  baseId?: string;
  tableId?: string;
  onClose: () => void;
}

/** Upload CSV/XLSX → preview → new table or existing table with column mapping → import. */
export function ImportDialog({ baseId: initialBase, tableId: initialTable, onClose }: Props) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const bases = useBases();
  const editableBases = (bases.data ?? []).filter((b) => permissionsFor(b.role).canEdit);
  const [baseId, setBaseId] = useState(initialBase ?? '');
  const base = useBase(baseId || undefined);
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<ImportSheetPreview[] | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [mode, setMode] = useState<'new' | 'existing'>(initialTable ? 'existing' : 'new');
  const [tableTitle, setTableTitle] = useState('');
  const [tableId, setTableId] = useState(initialTable ?? '');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sheet = sheets?.[sheetIdx];
  const tables: Table[] = base.data?.tables ?? [];
  const target = tables.find((tb) => tb.id === tableId);
  const writable = (target?.columns ?? []).filter((c) => !['ID', 'CreatedTime', 'LastModifiedTime', 'Links', 'Lookup', 'Rollup', 'Formula'].includes(c.type));

  const autoMap = (headers: string[], tb?: Table) => {
    const m: Record<string, string> = {};
    for (const h of headers) {
      const col = tb?.columns.find((c) => c.title.trim().toLowerCase() === h.trim().toLowerCase());
      if (col) m[h] = col.id;
    }
    setMapping(m);
  };

  const preview = async (f: File) => {
    if (!baseId) {
      setError(t('Choose a base first'));
      return;
    }
    setFile(f);
    setBusy(true);
    setError(null);
    try {
      const res = await platformApi.importPreview(baseId, f);
      setSheets(res.sheets);
      setSheetIdx(0);
      setTableTitle(f.name.replace(/\.(csv|xlsx|xls)$/i, ''));
      if (res.sheets[0]) autoMap(res.sheets[0].headers, target);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!file || !baseId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await platformApi.importFile(baseId, file, {
        tableTitle: mode === 'new' ? tableTitle.trim() || file.name : undefined,
        tableId: mode === 'existing' ? tableId : undefined,
        columnMap: mode === 'existing' ? Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) : undefined,
        sheet: sheet?.name,
      });
      await qc.invalidateQueries({ queryKey: qk.base(baseId) });
      await qc.invalidateQueries({ queryKey: qk.records(res.table.id) });
      toast(t('Imported {n} records into {table}', { n: res.inserted, table: res.table.title }), 'success');
      onClose();
      const fresh = await metaApi.getTable(res.table.id).catch(() => res.table);
      const view = fresh.views?.[0];
      navigate(view ? `/base/${baseId}/table/${fresh.id}/view/${view.id}` : `/base/${baseId}/table/${fresh.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={<><Icon name="upload" /> {t('Import CSV / Excel')}</>}
      onClose={onClose}
      width={720}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !sheet || (mode === 'existing' ? !tableId || !Object.values(mapping).some(Boolean) : !tableTitle.trim())}
            onClick={run}
          >
            {busy && sheets ? t('Importing…') : t('Import')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        {!initialBase && (
          <>
            <label className="field-label">{t('Base')}</label>
            <select className="input" value={baseId} onChange={(e) => setBaseId(e.target.value)}>
              <option value="">{t('Choose a base…')}</option>
              {editableBases.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
          </>
        )}
        <label className="field-label">{t('File')}</label>
        <label className={`dropzone ${!baseId ? 'disabled' : ''}`}>
          <input
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            disabled={!baseId}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void preview(f);
              e.target.value = '';
            }}
          />
          <Icon name="upload" size={20} />
          <span>{file ? file.name : t('Choose a .csv or .xlsx file')}</span>
          {busy && !sheets && <span className="muted small">{t('Reading file…')}</span>}
        </label>
      </div>

      {sheets && sheet && (
        <>
          {sheets.length > 1 && (
            <div className="tabs">
              {sheets.map((s, i) => (
                <button key={s.name} className={`tab ${i === sheetIdx ? 'active' : ''}`} onClick={() => { setSheetIdx(i); autoMap(s.headers, target); }}>
                  {s.name}
                </button>
              ))}
            </div>
          )}
          <div className="segmented">
            <button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>
              {t('Create a new table')}
            </button>
            <button className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')} disabled={!tables.length}>
              {t('Add to an existing table')}
            </button>
          </div>
          {mode === 'new' ? (
            <div className="form-grid">
              <label className="field-label">{t('Table name')}</label>
              <input className="input" value={tableTitle} onChange={(e) => setTableTitle(e.target.value)} />
            </div>
          ) : (
            <div className="form-grid">
              <label className="field-label">{t('Table')}</label>
              <select
                className="input"
                value={tableId}
                onChange={(e) => {
                  setTableId(e.target.value);
                  autoMap(sheet.headers, tables.find((tb) => tb.id === e.target.value));
                }}
              >
                <option value="">{t('Choose a table…')}</option>
                {tables.map((tb) => (
                  <option key={tb.id} value={tb.id}>
                    {tb.title}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="import-preview">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>{t('Column in file')}</th>
                  <th>{mode === 'new' ? t('Detected type') : t('Import into field')}</th>
                  <th>{t('Sample values')}</th>
                </tr>
              </thead>
              <tbody>
                {sheet.headers.map((h, i) => (
                  <tr key={h + i}>
                    <td>
                      <b>{h}</b>
                    </td>
                    <td>
                      {mode === 'new' ? (
                        <span className="row-flex">
                          <FieldIcon type={sheet.inferredTypes[i] ?? 'SingleLineText'} /> {t(FIELD_LABELS[sheet.inferredTypes[i] ?? 'SingleLineText'])}
                        </span>
                      ) : (
                        <select className="input input-sm" value={mapping[h] ?? ''} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })} disabled={!target}>
                          <option value="">{t('— skip —')}</option>
                          {writable.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.title}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="muted small sample-cell">
                      {sheet.sampleRows
                        .slice(0, 3)
                        .map((r) => (r[i] === null || r[i] === undefined ? '' : String(r[i])))
                        .filter(Boolean)
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {error && <div className="notice notice-error">{error}</div>}
    </Modal>
  );
}
