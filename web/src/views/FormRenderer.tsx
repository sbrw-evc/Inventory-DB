import { useState } from 'react';
import type { RecordData, Table, View } from '@shared';
import { FieldInput } from '../cells/FieldInput';
import { Icon } from '../components/Icon';
import { t } from '../i18n';
import { useBaseData } from '../lib/baseContext';
import type { ResolvedColumn } from '../lib/viewColumns';

interface Props {
  table: Table;
  view: View;
  fields: ResolvedColumn[];
  onSubmit: (values: Record<string, unknown>) => Promise<RecordData | null>;
  disabled?: boolean;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Fillable form for a form view (builder preview and the public shared form). */
export function FormRenderer({ table, view, fields, onSubmit, disabled }: Props) {
  const { isPublic } = useBaseData();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const f of fields) {
      const required = f.required ?? f.column.required;
      if (required && isEmpty(values[f.column.id])) errs[f.column.id] = t('This field is required');
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await onSubmit(values);
      if (res !== null) {
        setDone(true);
        setValues({});
        if (view.meta.formRedirectUrl && isPublic) window.location.href = view.meta.formRedirectUrl;
      }
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="form-card form-done">
        <div className="form-done-icon">
          <Icon name="check" size={28} />
        </div>
        <h2>{view.meta.formSubmitMessage || t('Thank you! Your response has been submitted.')}</h2>
        <button className="btn" onClick={() => setDone(false)}>
          {t('Submit another response')}
        </button>
      </div>
    );
  }

  return (
    <form className="form-card" onSubmit={submit} noValidate>
      <h1 className="form-heading">{view.meta.formHeading || table.title}</h1>
      {view.meta.formSubheading && <p className="form-subheading">{view.meta.formSubheading}</p>}
      {fields.map((f) => {
        const required = f.required ?? f.column.required;
        const uploadBlocked = isPublic && f.column.type === 'Attachment';
        return (
          <div key={f.column.id} className={`form-field ${errors[f.column.id] ? 'has-error' : ''}`}>
            <label className="form-label">
              {f.label || f.column.title}
              {required && <span className="required-mark">*</span>}
            </label>
            {(f.help || f.column.description) && <div className="form-help">{f.help || f.column.description}</div>}
            {uploadBlocked ? (
              <div className="muted small">{t('File uploads are not available in public forms.')}</div>
            ) : (
              <FieldInput
                column={f.column}
                value={values[f.column.id]}
                readOnly={disabled}
                onChange={(v) => {
                  setValues((s) => ({ ...s, [f.column.id]: v }));
                  setErrors((s) => {
                    const n = { ...s };
                    delete n[f.column.id];
                    return n;
                  });
                }}
              />
            )}
            {errors[f.column.id] && <div className="error-text small">{errors[f.column.id]}</div>}
          </div>
        );
      })}
      {serverError && <div className="notice notice-error">{serverError}</div>}
      <div className="form-submit">
        <button type="submit" className="btn btn-primary" disabled={submitting || disabled}>
          {submitting ? t('Submitting…') : t('Submit')}
        </button>
      </div>
    </form>
  );
}
