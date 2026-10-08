import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, nb, type FieldSchema, type ModelSchema, type NbObject } from './api';
import { RefSelect } from './components';
import { isChoice, isRef } from './format';
import { useCustomFields } from './hooks';
import { fieldLabel, t, valueLabel } from './i18n';

type Values = Record<string, unknown>;

const HIDDEN = new Set(['assigned_object_type']);

/** Form value for a serialized API value. */
function toFormValue(f: FieldSchema, v: unknown): unknown {
  if (v == null) return f.kind === 'm2m' ? [] : f.kind === 'bool' ? false : null;
  if (f.kind === 'fk') return isRef(v) ? v.id : v;
  if (f.kind === 'm2m') return Array.isArray(v) ? v.map((x) => (isRef(x) ? x.id : x)) : [];
  if (f.kind === 'choice') return isChoice(v) ? v.value : v;
  if (f.kind === 'json') return JSON.stringify(v, null, 2);
  return v;
}

function initialValues(model: ModelSchema, obj: NbObject | undefined, presets: Values): Values {
  const vals: Values = {};
  for (const f of model.fields) {
    if (f.read_only) continue;
    if (obj) vals[f.name] = toFormValue(f, obj[f.name]);
    else vals[f.name] = f.default != null ? (f.kind === 'json' ? JSON.stringify(f.default) : f.default) : toFormValue(f, null);
  }
  if (model.taggable) vals.tags = obj ? ((obj.tags ?? []) as { id: number }[]).map((x) => x.id) : [];
  if (model.custom_fields) vals.custom_fields = { ...(obj?.custom_fields ?? {}) };
  for (const side of ['a_terminations', 'b_terminations']) {
    if (model.write_extras.includes(side)) vals[side] = obj ? ((obj[side] as { object_id: number }[]) ?? []).map((x) => x.object_id) : [];
  }
  return { ...vals, ...presets };
}

/** Extra filter params for reference pickers that depend on other values in the form. */
function refParams(model: ModelSchema, field: string, vals: Values, obj?: NbObject): Record<string, string | number> | undefined {
  const type = model.object_type;
  if (type === 'dcim.device' && (field === 'rack' || field === 'location') && vals.site) return { site_id: vals.site as number };
  if (type === 'dcim.device' && (field === 'primary_ip4' || field === 'primary_ip6') && obj) return { device_id: obj.id, family: field === 'primary_ip4' ? 4 : 6 };
  if (type === 'dcim.interface' && field === 'lag' && vals.device) return { device_id: vals.device as number, type: 'lag' };
  if (type === 'dcim.interface' && field === 'parent' && vals.device) return { device_id: vals.device as number };
  if (type === 'dcim.location' && field === 'parent' && vals.site) return { site_id: vals.site as number };
  if (type === 'ipam.vlan' && field === 'group' && vals.site) return { site_id: vals.site as number };
  return undefined;
}

export function ObjectForm({
  model,
  obj,
  presets = {},
  onSaved,
  onCancel,
}: {
  model: ModelSchema;
  obj?: NbObject;
  presets?: Values;
  onSaved: (o: NbObject) => void;
  onCancel?: () => void;
}) {
  const [vals, setVals] = useState<Values>(() => initialValues(model, obj, presets));
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: cfDefs } = useCustomFields(model.custom_fields ? model.object_type : undefined);
  const set = (k: string, v: unknown) => setVals((s) => ({ ...s, [k]: v }));
  const fields = useMemo(() => model.fields.filter((f) => !f.read_only && !HIDDEN.has(f.name)), [model]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    const body: Values = {};
    const localErrors: Record<string, string[]> = {};
    for (const f of fields) {
      let v = vals[f.name];
      if (f.kind === 'json') {
        if (v == null || v === '') v = null;
        else {
          try {
            v = JSON.parse(String(v));
          } catch {
            localErrors[f.name] = [t('invalidJson')];
          }
        }
      }
      if ((f.kind === 'int' || f.kind === 'float') && v !== null && v !== '' && v !== undefined) v = Number(v);
      if (v === '' && f.kind !== 'string' && f.kind !== 'text') v = null;
      if (f.kind === 'slug' && !obj && (v == null || v === '')) continue; // server generates it
      body[f.name] = v;
    }
    if (model.object_type === 'ipam.ipaddress') body.assigned_object_type = body.assigned_object_id ? 'dcim.interface' : null;
    if (model.taggable) body.tags = vals.tags;
    if (model.custom_fields && cfDefs?.length) body.custom_fields = vals.custom_fields;
    for (const side of ['a_terminations', 'b_terminations']) {
      if (model.write_extras.includes(side)) body[side] = ((vals[side] as number[]) ?? []).map((id) => ({ object_type: 'dcim.interface', object_id: id }));
    }
    if (Object.keys(localErrors).length) {
      setErrors(localErrors);
      return;
    }
    setBusy(true);
    try {
      const saved = obj ? await nb.update(model, obj.id, body) : await nb.create(model, body);
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setFormError(err.message);
      } else setFormError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const row = (name: string, label: string, control: ReactNode, required = false, check = false) => (
    <label key={name} className={`${required ? 'req' : ''} ${check ? 'check' : ''}`.trim()} htmlFor={check ? undefined : `nbf-${name}`}>
      {check ? (
        <>
          {control}
          <span>{label}</span>
        </>
      ) : (
        <>
          <span>{label}</span>
          {control}
        </>
      )}
      {errors[name]?.map((m, i) => (
        <span key={i} className="err">
          {m}
        </span>
      ))}
    </label>
  );

  const control = (f: FieldSchema): ReactNode => {
    const id = `nbf-${f.name}`;
    const v = vals[f.name];
    if (model.object_type === 'ipam.ipaddress' && f.name === 'assigned_object_id') {
      return <RefSelect id={id} objectType="dcim.interface" value={(v as number) ?? null} onChange={(x) => set(f.name, x)} />;
    }
    switch (f.kind) {
      case 'bool':
        return <input id={id} type="checkbox" checked={!!v} onChange={(e) => set(f.name, e.target.checked)} />;
      case 'choice':
        return (
          <select id={id} value={(v as string) ?? ''} onChange={(e) => set(f.name, e.target.value || null)}>
            {!f.required && <option value="">—</option>}
            {f.choices?.map((c) => (
              <option key={String(c.value)} value={String(c.value)}>
                {valueLabel(String(c.value), c.label)}
              </option>
            ))}
          </select>
        );
      case 'int':
      case 'float':
        if (f.choices)
          return (
            <select id={id} value={v == null ? '' : String(v)} onChange={(e) => set(f.name, e.target.value === '' ? null : Number(e.target.value))}>
              {f.choices.map((c) => (
                <option key={String(c.value)} value={String(c.value)}>
                  {c.label}
                </option>
              ))}
            </select>
          );
        return (
          <input id={id} className="nb-input" type="number" step={f.kind === 'float' ? 'any' : 1} min={f.min ?? undefined} max={f.max ?? undefined} value={v == null ? '' : String(v)} onChange={(e) => set(f.name, e.target.value)} />
        );
      case 'text':
      case 'json':
        return <textarea id={id} rows={f.kind === 'json' ? 3 : 4} value={(v as string) ?? ''} onChange={(e) => set(f.name, e.target.value)} />;
      case 'color':
        return (
          <span style={{ display: 'flex', gap: 6 }}>
            <input type="color" value={`#${(v as string) || '9e9e9e'}`} onChange={(e) => set(f.name, e.target.value.slice(1))} aria-label={fieldLabel(f.name)} />
            <input id={id} className="nb-input" value={(v as string) ?? ''} onChange={(e) => set(f.name, e.target.value.replace(/^#/, ''))} />
          </span>
        );
      case 'date':
        return <input id={id} className="nb-input" type="date" value={(v as string) ?? ''} onChange={(e) => set(f.name, e.target.value)} />;
      case 'fk':
        return <RefSelect id={id} objectType={f.ref!} value={(v as number) ?? null} params={refParams(model, f.name, vals, obj)} onChange={(x) => set(f.name, x)} />;
      case 'm2m':
        return <RefSelect id={id} objectType={f.ref!} multiple value={(v as number[]) ?? []} onChange={(x) => set(f.name, x)} />;
      default:
        return (
          <input
            id={id}
            className="nb-input"
            value={(v as string) ?? ''}
            maxLength={f.max_length ?? undefined}
            placeholder={f.kind === 'cidr' ? '10.0.0.0/24' : f.kind === 'ipaddr' ? '10.0.0.1/24' : f.kind === 'mac' ? 'AA:BB:CC:DD:EE:FF' : undefined}
            onChange={(e) => set(f.name, e.target.value)}
          />
        );
    }
  };

  const cfValues = (vals.custom_fields ?? {}) as Values;
  const setCf = (k: string, v: unknown) => set('custom_fields', { ...cfValues, [k]: v });

  return (
    <form className="nb-form" onSubmit={submit} noValidate>
      {formError && <div className="nb-alert">{formError}</div>}
      {model.write_extras.includes('a_terminations') &&
        (['a_terminations', 'b_terminations'] as const).map((side) =>
          row(side, fieldLabel(side), <RefSelect objectType="dcim.interface" multiple value={(vals[side] as number[]) ?? []} params={{ cabled: 'false' }} placeholder={t('selectInterface')} onChange={(x) => set(side, x)} />, !obj),
        )}
      {fields.map((f) => row(f.name, fieldLabel(f.name), control(f), f.required && !(f.kind === 'slug' && !obj) && f.kind !== 'bool', f.kind === 'bool'))}
      {model.taggable && row('tags', t('tags'), <RefSelect objectType="extras.tag" multiple value={(vals.tags as number[]) ?? []} onChange={(x) => set('tags', x)} />)}
      {model.custom_fields && !!cfDefs?.length && (
        <fieldset>
          <legend>{t('customFields')}</legend>
          {cfDefs.map((d) => {
            const name = String(d.name);
            const v = cfValues[name];
            const type = isChoice(d.type) ? d.type.value : String(d.type);
            const choices = (d.choices as string[] | null) ?? [];
            let ctl: ReactNode;
            if (type === 'boolean') ctl = <input type="checkbox" checked={!!v} onChange={(e) => setCf(name, e.target.checked)} />;
            else if (type === 'select')
              ctl = (
                <select value={(v as string) ?? ''} onChange={(e) => setCf(name, e.target.value || null)}>
                  <option value="">—</option>
                  {choices.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              );
            else if (type === 'multiselect')
              ctl = (
                <select multiple value={(v as string[]) ?? []} onChange={(e) => setCf(name, [...e.target.selectedOptions].map((o) => o.value))}>
                  {choices.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              );
            else
              ctl = (
                <input
                  className="nb-input"
                  type={type === 'integer' || type === 'decimal' ? 'number' : type === 'date' ? 'date' : type === 'url' ? 'url' : 'text'}
                  value={v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                  onChange={(e) => setCf(name, e.target.value === '' ? null : type === 'integer' || type === 'decimal' ? Number(e.target.value) : e.target.value)}
                />
              );
            return (
              <label key={name} className={d.required ? 'req' : ''}>
                <span>{String(d.label || name)}</span>
                {ctl}
              </label>
            );
          })}
          {errors.custom_fields?.map((m, i) => (
            <span key={i} className="err">
              {m}
            </span>
          ))}
        </fieldset>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="nb-btn primary" type="submit" disabled={busy}>
          {obj ? t('save') : t('create')}
        </button>
        {onCancel && (
          <button className="nb-btn" type="button" onClick={onCancel}>
            {t('cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
