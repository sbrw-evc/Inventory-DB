import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { nb, request, toQuery, type ModelSchema, type NbObject, type Page } from './api';
import { Chip, ErrorBox, KV, Tabs, Value } from './components';
import { configFor, objectRoute } from './config';
import { changedKeys, statusTone } from './format';
import { useAsync, useMe } from './hooks';
import { currentLang, fieldLabel, t, typeLabel, valueLabel } from './i18n';
import { ObjectForm } from './ObjectForm';

/** Read-only details of an object: all fields, computed values, tags, custom fields and timestamps. */
export function ObjectDetails({ model, obj }: { model: ModelSchema; obj: NbObject }) {
  const skip = new Set(['id', 'url', 'display_url', 'display', 'tags', 'custom_fields', 'created', 'last_updated', 'prechange_data', 'postchange_data']);
  const keys = [...model.fields.map((f) => f.name), ...Object.keys(obj).filter((k) => !model.fields.some((f) => f.name === k))].filter((k) => !skip.has(k) && k in obj);
  const rows: [string, ReactNode][] = keys.map((k) => [fieldLabel(k), <Value key={k} v={obj[k]} name={k} />]);
  if (obj.tags) rows.push([t('tags'), <Value key="tags" v={obj.tags} name="tags" />]);
  for (const [k, v] of Object.entries(obj.custom_fields ?? {})) rows.push([k, <Value key={`cf_${k}`} v={v} />]);
  if (obj.created) rows.push([t('created'), <Value key="c" v={obj.created} name="created" />]);
  if (obj.last_updated) rows.push([t('lastUpdated'), <Value key="u" v={obj.last_updated} name="last_updated" />]);
  return (
    <>
      <KV rows={rows} />
      {model.object_type === 'extras.objectchange' && <ChangeDiff pre={obj.prechange_data as never} post={obj.postchange_data as never} />}
    </>
  );
}

function ChangeDiff({ pre, post }: { pre: Record<string, unknown> | null; post: Record<string, unknown> | null }) {
  const keys = changedKeys(pre, post);
  if (!keys.length) return null;
  return (
    <div className="nb-table-wrap" style={{ marginTop: 8 }}>
      <table className="nb-table">
        <thead>
          <tr>
            <th />
            <th>−</th>
            <th>+</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <td>{fieldLabel(k)}</td>
              <td>
                <Value v={pre?.[k]} name={k} />
              </td>
              <td>
                <Value v={post?.[k]} name={k} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ObjectHistory({ objectType, id }: { objectType: string; id: number }) {
  const { data, error, loading } = useAsync(
    () => request<Page>('GET', `/extras/object-changes${toQuery({ changed_object_type: objectType, changed_object_id: id, limit: 50 })}`),
    [objectType, id],
  );
  if (loading && !data) return <div className="nb-muted">{t('loading')}</div>;
  if (error) return <ErrorBox error={error} />;
  if (!data?.results.length) return <div className="nb-muted">{t('noChanges')}</div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {data.results.map((c) => {
        const action = c.action as { value: string; label: string };
        const keys = changedKeys(c.prechange_data as never, c.postchange_data as never);
        return (
          <div key={c.id} style={{ borderBottom: '1px solid var(--nb-border)', paddingBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Chip tone={statusTone(action.value)}>{valueLabel(action.value, action.label)}</Chip>
              <span>{new Date(String(c.time ?? c.created)).toLocaleString(currentLang())}</span>
              <span className="nb-muted">{t('by', { user: String(c.user_name ?? '—') })}</span>
            </div>
            {action.value === 'update' && keys.length > 0 && (
              <div className="nb-muted" style={{ marginTop: 4 }}>
                {keys.map((k) => fieldLabel(k)).join(', ')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Right-docked panel: Details · Edit · History for one object, or a create form for `id === 'new'`. */
export function SidePanel({
  model,
  id,
  presets,
  onClose,
  onChanged,
}: {
  model: ModelSchema;
  id: number | 'new';
  presets?: Record<string, unknown>;
  onClose: () => void;
  onChanged: (obj: NbObject | null) => void;
}) {
  const { data: me } = useMe();
  const canWrite = !!me?.can_write && !model.read_only;
  const [tab, setTab] = useState<'details' | 'edit' | 'history'>(id === 'new' ? 'edit' : 'details');
  const { data: obj, error, reload } = useAsync(() => (id === 'new' ? Promise.resolve(undefined) : nb.get(model, id)), [model.object_type, id]);
  const [msg, setMsg] = useState<string | null>(null);
  const page = configFor(model.app, model.path).page;

  async function remove() {
    if (id === 'new' || !confirm(t('confirmDelete', { n: 1 }))) return;
    try {
      await nb.remove(model, id);
      onChanged(null);
      onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  const tabs = id === 'new' ? [{ key: 'edit', label: t('create') }] : [
    { key: 'details', label: t('details') },
    ...(canWrite ? [{ key: 'edit', label: t('edit') }] : []),
    { key: 'history', label: t('history') },
  ];

  return (
    <aside className="nb-panel" aria-label={typeLabel(`${model.app}/${model.path}`, model.verbose_name_plural)}>
      <div className="nb-panel-title">
        <span>{id === 'new' ? `${t('add')}: ${typeLabel(`${model.app}/${model.path}`, model.verbose_name_plural)}` : (obj?.display ?? '…')}</span>
        <span className="nb-spacer" />
        <button className="nb-btn" onClick={onClose} aria-label={t('close')}>
          ×
        </button>
      </div>
      <Tabs tabs={tabs} active={tab} onChange={(k) => setTab(k as never)} />
      <div className="nb-panel-body">
        {msg && <div className="nb-alert">{msg}</div>}
        <ErrorBox error={error} />
        {tab === 'details' && obj && <ObjectDetails model={model} obj={obj} />}
        {tab === 'edit' && (id === 'new' || obj) && (
          <ObjectForm
            key={`${model.object_type}-${id}-${obj?.last_updated ?? ''}`}
            model={model}
            obj={obj}
            presets={presets}
            onSaved={(o) => {
              onChanged(o);
              if (id === 'new') onClose();
              else {
                reload();
                setTab('details');
              }
            }}
            onCancel={id === 'new' ? onClose : () => setTab('details')}
          />
        )}
        {tab === 'history' && id !== 'new' && <ObjectHistory objectType={model.object_type} id={id} />}
      </div>
      {id !== 'new' && tab === 'details' && (
        <div className="nb-panel-foot">
          {page && obj && (
            <Link className="nb-btn primary" to={objectRoute(model.app, model.path, obj.id)}>
              {t('open')}
            </Link>
          )}
          {canWrite && (
            <button className={`nb-btn ${page ? '' : 'primary'}`} onClick={() => setTab('edit')}>
              {t('edit')}
            </button>
          )}
          {canWrite && (
            <button className="nb-btn danger" onClick={remove}>
              {t('delete')}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
