import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, nb, type ModelSchema, type NbObject, type Ref } from './api';
import { ErrorBox, Layout, MonitoringChip, Value } from './components';
import { configFor, objectRoute } from './config';
import { apiParams, statusTone, toCsv } from './format';
import { findModel, useAsync, useInterval, useMe, useMonitoring, useSchema } from './hooks';
import { fieldLabel, t, typeLabel, valueLabel } from './i18n';
import { SidePanel } from './SidePanel';

const PAGE_SIZES = [25, 50, 100, 250];
/** Filter keys that aren't model fields, mapped to the referenced object type. */
const EXTRA_REFS: Record<string, string> = {
  device_id: 'dcim.device',
  site_id: 'dcim.site',
  rack_id: 'dcim.rack',
  location_id: 'dcim.location',
  manufacturer_id: 'dcim.manufacturer',
  tenant_id: 'tenancy.tenant',
  vrf_id: 'ipam.vrf',
  region_id: 'dcim.region',
  cluster_id: 'virtualization.cluster',
  virtual_machine_id: 'virtualization.virtualmachine',
  provider_id: 'circuits.provider',
};
const BOOL_FILTERS = new Set(['enabled', 'cabled', 'has_primary_ip', 'is_pool', 'mgmt_only']);

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** One `Field: value ▾` filter control bound to a URL query key. */
function FilterControl({ model, schema, k, value, onChange }: { model: ModelSchema; schema: ModelSchema[]; k: string; value: string; onChange: (v: string) => void }) {
  const base = k.replace(/_id$/, '');
  const field = model.fields.find((f) => f.name === (k.endsWith('_id') ? base : k));
  const refType = field?.kind === 'fk' ? field.ref : k.endsWith('_id') ? (k === 'parent_id' ? model.object_type : EXTRA_REFS[k]) : k === 'tag' ? 'extras.tag' : null;
  const refModel = refType ? findModel(schema, refType) : undefined;
  const { data: options } = useAsync(
    () => (refModel ? nb.list<Ref>(refModel, { brief: 1, limit: 1000 }).then((p) => p.results) : Promise.resolve([] as Ref[])),
    [refModel?.object_type],
  );
  const label = k === 'tag' ? t('tags') : fieldLabel(base);
  let control: ReactNode;
  if (refModel) {
    control = (
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">{t('any')}</option>
        {k !== 'tag' && <option value="null">{t('none')}</option>}
        {options?.map((o) => (
          <option key={o.id} value={k === 'tag' ? String(o.slug) : String(o.id)}>
            {o.display}
          </option>
        ))}
      </select>
    );
  } else if (field?.choices) {
    control = (
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">{t('any')}</option>
        {field.choices.map((c) => (
          <option key={String(c.value)} value={String(c.value)}>
            {valueLabel(String(c.value), c.label)}
          </option>
        ))}
      </select>
    );
  } else if (k === 'family') {
    control = (
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">{t('any')}</option>
        <option value="4">IPv4</option>
        <option value="6">IPv6</option>
      </select>
    );
  } else if (BOOL_FILTERS.has(k) || field?.kind === 'bool') {
    control = (
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        <option value="">{t('any')}</option>
        <option value="true">{t('yes')}</option>
        <option value="false">{t('no')}</option>
      </select>
    );
  } else {
    control = <TextFilter value={value} onChange={onChange} label={label} />;
  }
  return (
    <div className={`nb-filter ${value ? 'set' : ''}`}>
      <span>{label}:</span>
      {control}
    </div>
  );
}

function TextFilter({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input aria-label={label} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onChange(v)} onKeyDown={(e) => e.key === 'Enter' && onChange(v)} />;
}

function ImportPanel({ model, onClose, onDone }: { model: ModelSchema; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ ok?: string; error?: string; rows?: { row: number; errors: Record<string, string[]> }[] }>({});
  async function run() {
    setResult({});
    try {
      const r = await nb.importCsv(model.object_type, text);
      setResult({ ok: t('imported', { n: r.created }) });
      onDone();
    } catch (e) {
      if (e instanceof ApiError) setResult({ error: e.message, rows: Array.isArray(e.details) ? (e.details as never) : undefined });
      else setResult({ error: String(e) });
    }
  }
  const header = ['name', ...model.fields.filter((f) => !f.read_only && f.name !== 'name').map((f) => f.name)].slice(0, 8).join(',');
  return (
    <aside className="nb-panel">
      <div className="nb-panel-title">
        <span>
          {t('importCsv')}: {typeLabel(`${model.app}/${model.path}`, model.verbose_name_plural)}
        </span>
        <span className="nb-spacer" />
        <button className="nb-btn" onClick={onClose} aria-label={t('close')}>
          ×
        </button>
      </div>
      <div className="nb-panel-body nb-form">
        <p className="nb-muted" style={{ margin: 0 }}>
          {t('importHint')}
        </p>
        <textarea rows={14} value={text} placeholder={header} onChange={(e) => setText(e.target.value)} style={{ fontFamily: 'monospace' }} />
        {result.ok && <div className="nb-alert ok">{result.ok}</div>}
        {result.error && (
          <div className="nb-alert">
            {result.error}
            {result.rows?.map((r) => (
              <div key={r.row}>
                #{r.row}:{' '}
                {Object.entries(r.errors ?? {})
                  .map(([k, v]) => `${k}: ${(v as string[]).join(' ')}`)
                  .join('; ')}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="nb-panel-foot">
        <button className="nb-btn primary" onClick={run} disabled={!text.trim()}>
          {t('import')}
        </button>
        <button className="nb-btn" onClick={onClose}>
          {t('cancel')}
        </button>
      </div>
    </aside>
  );
}

/** Generic list page for any DCIM/IPAM object type with filters in the URL. */
export function ObjectListPage({ app }: { app: string }) {
  const { path = '', id: routeId } = useParams();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const { data: schema, error: schemaError } = useSchema();
  const { data: me } = useMe();
  const model = findModel(schema, `${app}/${path}`);
  const cfg = configFor(app, path);
  const params = useMemo(() => apiParams(sp), [sp]);
  const limit = Number(sp.get('limit') ?? 50);
  const offset = Number(sp.get('offset') ?? 0);
  const [live, setLive] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [flash, setFlash] = useState<string | null>(null);
  const sel = routeId ?? sp.get('_sel');
  const canWrite = !!me?.can_write && !model?.read_only;

  const list = useAsync(
    () => (model ? nb.list(model, { ordering: cfg.ordering, ...params, limit, offset }) : Promise.resolve(undefined)),
    [model?.object_type, JSON.stringify(params), limit, offset],
  );
  useInterval(list.reload, 30000, live && !!model);
  useEffect(() => setSelected(new Set()), [model?.object_type, JSON.stringify(params)]);

  const counterField = cfg.counters ? model?.fields.find((f) => f.name === cfg.counters) : undefined;
  const counters = useAsync(async () => {
    if (!model || !counterField?.choices) return [];
    const rest = { ...params };
    delete rest[counterField.name];
    delete rest.offset;
    return Promise.all(
      counterField.choices.map(async (c) => ({ value: String(c.value), label: c.label, count: (await nb.list(model, { ...rest, [counterField.name]: String(c.value), limit: 1 })).count })),
    );
  }, [model?.object_type, counterField?.name, JSON.stringify({ ...params, [cfg.counters ?? '']: undefined }), list.data?.count]);

  const rows = list.data?.results ?? [];
  const monitoring = useMonitoring('dcim.device', model?.object_type === 'dcim.device' ? rows.map((r) => r.id) : []);
  const columns = cfg.columns.filter((c) => c !== 'monitoring' || monitoring);

  const update = (changes: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (resetPage) next.delete('offset');
    setSp(next, { replace: true });
  };
  const closePanel = () => {
    if (routeId) navigate(`${objectRoute(app, path)}${sp.toString() ? `?${sp}` : ''}`);
    else update({ _sel: null }, false);
  };

  if (schemaError) return <Layout><ErrorBox error={schemaError instanceof ApiError && schemaError.status === 401 ? t('signInRequired') : schemaError} /></Layout>;
  if (!schema) return <Layout><div className="nb-empty">{t('loading')}</div></Layout>;
  if (!model) return <Layout><div className="nb-empty">{t('notFound')}</div></Layout>;

  const sortable = new Set(['id', ...model.fields.filter((f) => f.kind !== 'm2m' && f.kind !== 'json').map((f) => f.name), ...(model.object_type === 'extras.objectchange' ? ['time'] : [])]);
  const ordering = sp.get('ordering') ?? '';
  const sortBy = (c: string) => {
    const key = c === 'time' ? 'created' : c;
    update({ ordering: ordering === key ? `-${key}` : ordering === `-${key}` ? null : key }, false);
  };
  const treeIndent = model.object_type === 'ipam.prefix' && !ordering && !params.q;

  const cell = (o: NbObject, c: string, first: boolean): ReactNode => {
    if (c === 'monitoring') return <MonitoringChip status={monitoring?.get(o.id)} />;
    if (first) {
      const label = c === 'id' ? `#${o.id}` : o[c] != null && typeof o[c] !== 'object' ? String(o[c]) : o.display;
      const to = cfg.page ? objectRoute(app, path, o.id) : `?${new URLSearchParams({ ...Object.fromEntries(sp), _sel: String(o.id) })}`;
      return (
        <>
          {treeIndent && Number(o._depth) > 0 && <span className="nb-tree-indent">{'· '.repeat(Number(o._depth))}</span>}
          <Link to={to} onClick={(e) => e.stopPropagation()}>
            {label}
          </Link>
        </>
      );
    }
    return <Value v={c === 'time' ? o.created : o[c]} name={c} />;
  };

  async function exportCsv() {
    if (!model) return;
    const all = await nb.list(model, { ...params, limit: 1000, offset: 0 });
    const cols = ['id', ...columns.filter((c) => c !== 'monitoring' && c !== 'id')];
    download(`${model.path}.csv`, toCsv(all.results, cols));
  }
  async function bulkDelete() {
    if (!model || !confirm(t('confirmDelete', { n: selected.size }))) return;
    try {
      await nb.bulkRemove(model, [...selected]);
      setSelected(new Set());
      setFlash(t('deleted'));
      list.reload();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : String(e));
    }
  }

  const panel =
    sel === 'import' ? (
      <ImportPanel model={model} onClose={closePanel} onDone={list.reload} />
    ) : sel ? (
      <SidePanel
        key={`${model.object_type}-${sel}`}
        model={model}
        id={sel === 'new' ? 'new' : Number(sel)}
        onClose={closePanel}
        onChanged={() => list.reload()}
        presets={sel === 'new' ? presetsFrom(model, params) : undefined}
      />
    ) : undefined;

  const count = list.data?.count ?? 0;
  return (
    <Layout panel={panel}>
      <div className="nb-title">
        <h1>{typeLabel(`${app}/${path}`, model.verbose_name_plural)}</h1>
        <span className="nb-muted">{list.data ? count : ''}</span>
      </div>
      <div className="nb-toolbar">
        <input
          className="nb-input nb-search"
          type="search"
          placeholder={t('searchPlaceholder')}
          defaultValue={sp.get('q') ?? ''}
          onKeyDown={(e) => e.key === 'Enter' && update({ q: (e.target as HTMLInputElement).value })}
          onBlur={(e) => e.target.value !== (sp.get('q') ?? '') && update({ q: e.target.value })}
          aria-label={t('search')}
        />
        {canWrite && (
          <button className="nb-btn primary" onClick={() => update({ _sel: 'new' }, false)}>
            + {t('add')}
          </button>
        )}
        {canWrite && (
          <button className="nb-btn" onClick={() => update({ _sel: 'import' }, false)}>
            {t('importCsv')}
          </button>
        )}
        <button className="nb-btn" onClick={exportCsv}>
          {t('exportCsv')}
        </button>
        <button
          className="nb-btn"
          onClick={() => {
            void navigator.clipboard?.writeText(window.location.href);
            setFlash(t('copied'));
          }}
        >
          {t('copyLink')}
        </button>
        {[...sp.keys()].some((k) => k !== '_sel' && k !== 'limit') && (
          <button className="nb-btn" onClick={() => setSp(new URLSearchParams(), { replace: true })}>
            {t('resetFilters')}
          </button>
        )}
        <span className="nb-spacer" />
        <span className={`nb-live ${live ? 'on' : ''}`} onClick={() => setLive(!live)} role="switch" aria-checked={live}>
          {live ? t('live') : t('paused')}
        </span>
      </div>
      {cfg.filters && (
        <div className="nb-filters">
          {cfg.filters.map((k) => (
            <FilterControl key={k} model={model} schema={schema} k={k} value={sp.get(k) ?? ''} onChange={(v) => update({ [k]: v })} />
          ))}
        </div>
      )}
      {!!counters.data?.length && (
        <div className="nb-counters">
          {counters.data.map((c) => (
            <button key={c.value} className={`nb-counter ${statusTone(c.value)} ${sp.get(cfg.counters!) === c.value ? 'selected' : ''}`} onClick={() => update({ [cfg.counters!]: sp.get(cfg.counters!) === c.value ? null : c.value })}>
              <b>{c.count}</b>
              {valueLabel(c.value, c.label)}
            </button>
          ))}
        </div>
      )}
      {flash && (
        <div className="nb-alert info" onClick={() => setFlash(null)}>
          {flash}
        </div>
      )}
      {me && !me.can_write && !model.read_only && <div className="nb-muted" style={{ margin: '6px 0' }}>{t('readOnlyRole')}</div>}
      {selected.size > 0 && (
        <div className="nb-bulkbar">
          <b>{t('selected', { n: selected.size })}</b>
          {canWrite && (
            <button className="nb-btn danger" onClick={bulkDelete}>
              {t('delete')}
            </button>
          )}
          <button className="nb-btn" onClick={() => setSelected(new Set())}>
            {t('clearSelection')}
          </button>
        </div>
      )}
      <ErrorBox error={list.error} />
      <div className="nb-table-wrap">
        <table className="nb-table">
          <thead>
            <tr>
              <th className="check">
                <input
                  type="checkbox"
                  aria-label={t('selected', { n: rows.length })}
                  checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                />
              </th>
              {columns.map((c) => {
                const key = c === 'time' ? 'created' : c;
                const arrow = ordering === key ? ' ▲' : ordering === `-${key}` ? ' ▼' : '';
                return (
                  <th key={c} className={sortable.has(c) ? 'sortable' : ''} onClick={() => sortable.has(c) && sortBy(c)}>
                    {c === 'id' ? 'ID' : fieldLabel(c)}
                    {arrow}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr
                key={o.id}
                className={`clickable ${String(o.id) === sel || selected.has(o.id) ? 'selected' : ''}`}
                onClick={() => (routeId ? navigate(`${objectRoute(app, path)}?_sel=${o.id}`) : update({ _sel: String(o.id) }, false))}
              >
                <td className="check" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={o.display}
                    checked={selected.has(o.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(o.id);
                      else next.delete(o.id);
                      setSelected(next);
                    }}
                  />
                </td>
                {columns.map((c, i) => (
                  <td key={c} className={i === 0 ? 'first' : undefined}>
                    {cell(o, c, i === 0)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!list.loading && rows.length === 0 && <div className="nb-empty">{t('noResults')}</div>}
        {list.loading && !list.data && <div className="nb-empty">{t('loading')}</div>}
      </div>
      <div className="nb-pager">
        <span>{count ? t('page', { from: offset + 1, to: Math.min(offset + limit, count), count }) : ''}</span>
        <label>
          {t('perPage')}{' '}
          <select value={limit} onChange={(e) => update({ limit: e.target.value })}>
            {PAGE_SIZES.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <button className="nb-btn" disabled={offset === 0} onClick={() => update({ offset: String(Math.max(0, offset - limit)) }, false)}>
          {t('prev')}
        </button>
        <button className="nb-btn" disabled={offset + limit >= count} onClick={() => update({ offset: String(offset + limit) }, false)}>
          {t('next')}
        </button>
      </div>
    </Layout>
  );
}

/** Prefill a create form from the active `<field>_id` filters (e.g. adding a rack while filtered by site). */
function presetsFrom(model: ModelSchema, params: Record<string, string[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of model.fields) {
    const v = params[`${f.name}_id`]?.[0];
    if (f.kind === 'fk' && v && v !== 'null') out[f.name] = Number(v);
  }
  return out;
}
