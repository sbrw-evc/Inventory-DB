import { useState } from 'react';
import type { Table, View } from '@shared';
import type { ViewPatch } from '../api/endpoints';
import { FieldIcon, Icon } from '../components/Icon';
import { t } from '../i18n';
import { useRecordMutations } from '../lib/records';
import type { Permissions } from '../lib/roles';
import { toast } from '../lib/toast';
import { moveColumn, patchResolved, type ResolvedColumn, toViewColumns } from '../lib/viewColumns';
import { FormRenderer } from './FormRenderer';

interface Props {
  table: Table;
  view: View;
  resolved: ResolvedColumn[];
  perms: Permissions;
  canEditView: boolean;
  update: (patch: ViewPatch) => void;
}

/** Form view: builder (reorder/hide fields, overrides, texts) and a live preview that submits records. */
export function FormBuilder({ table, view, resolved, perms, canEditView, update }: Props) {
  const [mode, setMode] = useState<'build' | 'preview'>(canEditView ? 'build' : 'preview');
  const [selected, setSelected] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const muts = useRecordMutations(table.id);
  const shown = resolved.filter((r) => r.show);
  const hidden = resolved.filter((r) => !r.show);
  const setColumns = (next: ResolvedColumn[]) => update({ columns: toViewColumns(next) });
  const setMeta = (meta: Partial<View['meta']>) => update({ meta: meta as View['meta'] });

  const submit = async (values: Record<string, unknown>) => {
    const created = await muts.createRecord(values);
    if (created) toast(t('Record created'), 'success');
    return created;
  };

  return (
    <div className="form-view">
      <div className="form-view-bar">
        {canEditView && (
          <div className="segmented">
            <button className={mode === 'build' ? 'active' : ''} onClick={() => setMode('build')}>
              <Icon name="edit" size={13} /> {t('Build')}
            </button>
            <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>
              <Icon name="eye" size={13} /> {t('Preview')}
            </button>
          </div>
        )}
      </div>
      {mode === 'preview' || !canEditView ? (
        <div className="form-canvas">
          <FormRenderer table={table} view={view} fields={shown} onSubmit={submit} disabled={!perms.canEdit} />
        </div>
      ) : (
        <div className="form-builder">
          <aside className="form-fields-panel">
            <div className="panel-title">{t('Fields')}</div>
            <div className="muted small">{t('Click a field to add it to the form.')}</div>
            {hidden.map((r) => (
              <button key={r.column.id} className="form-field-chip" onClick={() => setColumns(patchResolved(resolved, r.column.id, { show: true }))}>
                <FieldIcon type={r.column.type} /> {r.column.title}
                <Icon name="plus" size={13} className="push-right" />
              </button>
            ))}
            {!hidden.length && <div className="empty-hint">{t('All fields are on the form')}</div>}
            <div className="menu-footer">
              <button className="link-btn" onClick={() => setColumns(resolved.map((r) => ({ ...r, show: true })))}>
                {t('Add all')}
              </button>
              <button className="link-btn" onClick={() => setColumns(resolved.map((r) => ({ ...r, show: false })))}>
                {t('Remove all')}
              </button>
            </div>
          </aside>
          <div className="form-canvas">
            <div className="form-card builder">
              <input
                className="form-heading-input"
                value={view.meta.formHeading ?? ''}
                placeholder={table.title}
                onChange={(e) => setMeta({ formHeading: e.target.value })}
              />
              <textarea
                className="form-subheading-input"
                rows={2}
                value={view.meta.formSubheading ?? ''}
                placeholder={t('Add a description (optional)')}
                onChange={(e) => setMeta({ formSubheading: e.target.value })}
              />
              {!shown.length && <div className="empty-state-sm">{t('Add fields from the left panel')}</div>}
              {shown.map((r) => {
                const isSel = selected === r.column.id;
                const required = r.required ?? r.column.required;
                return (
                  <div
                    key={r.column.id}
                    className={`builder-field ${isSel ? 'selected' : ''} ${dragId === r.column.id ? 'dragging' : ''}`}
                    draggable
                    onDragStart={() => setDragId(r.column.id)}
                    onDragOver={(e) => {
                      if (!dragId || dragId === r.column.id) return;
                      e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragId) setColumns(moveColumn(resolved, dragId, r.column.id));
                      setDragId(null);
                    }}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => setSelected(r.column.id)}
                  >
                    <div className="builder-field-head">
                      <Icon name="drag" size={14} className="drag-handle" />
                      <FieldIcon type={r.column.type} />
                      <b>{r.label || r.column.title}</b>
                      {required && <span className="required-mark">*</span>}
                      <span className="spacer" />
                      <button
                        className="icon-btn"
                        title={t('Remove from form')}
                        onClick={(e) => {
                          e.stopPropagation();
                          setColumns(patchResolved(resolved, r.column.id, { show: false }));
                        }}
                      >
                        <Icon name="eyeOff" size={14} />
                      </button>
                    </div>
                    {isSel ? (
                      <div className="builder-field-settings" onClick={(e) => e.stopPropagation()}>
                        <label className="field-label">{t('Label')}</label>
                        <input
                          className="input input-sm"
                          value={r.label ?? ''}
                          placeholder={r.column.title}
                          onChange={(e) => setColumns(patchResolved(resolved, r.column.id, { label: e.target.value || undefined }))}
                        />
                        <label className="field-label">{t('Help text')}</label>
                        <input
                          className="input input-sm"
                          value={r.help ?? ''}
                          placeholder={r.column.description ?? ''}
                          onChange={(e) => setColumns(patchResolved(resolved, r.column.id, { help: e.target.value || undefined }))}
                        />
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={!!required}
                            disabled={r.column.required}
                            onChange={(e) => setColumns(patchResolved(resolved, r.column.id, { required: e.target.checked }))}
                          />
                          {t('Required')}
                        </label>
                      </div>
                    ) : (
                      (r.help || r.column.description) && <div className="form-help">{r.help || r.column.description}</div>
                    )}
                  </div>
                );
              })}
              <div className="builder-after">
                <label className="field-label">{t('Message after submit')}</label>
                <textarea
                  className="input"
                  rows={2}
                  value={view.meta.formSubmitMessage ?? ''}
                  placeholder={t('Thank you! Your response has been submitted.')}
                  onChange={(e) => setMeta({ formSubmitMessage: e.target.value })}
                />
                <label className="field-label">{t('Redirect URL after submit (public form, optional)')}</label>
                <input
                  className="input"
                  value={view.meta.formRedirectUrl ?? ''}
                  placeholder="https://"
                  onChange={(e) => setMeta({ formRedirectUrl: e.target.value || undefined })}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
