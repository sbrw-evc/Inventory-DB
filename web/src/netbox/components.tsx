import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { nb, type ModelSchema, type Ref } from './api';
import { isChoice, isRef, statusTone, utilTone, type MonitoringStatus, type Tone } from './format';
import { useSchema } from './hooks';
import { t, typeLabel, valueLabel } from './i18n';

/** API url (`/api/v1/dcim/devices/5/`) → UI route (`/dcim/devices/5`). */
export const uiHref = (apiUrl: string) => apiUrl.replace(/^\/api\/v1/, '').replace(/\/$/, '');

export function Chip({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`nb-chip ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function StatusChip({ value }: { value: { value: string; label: string } | null | undefined }) {
  if (!value) return <span className="nb-muted">—</span>;
  return <Chip tone={statusTone(value.value)}>{valueLabel(value.value, value.label)}</Chip>;
}

export function UtilBar({ value }: { value: number | null | undefined }) {
  const v = Math.max(0, Math.min(100, Number(value ?? 0)));
  const tone = utilTone(v);
  return (
    <span className="nb-util" title={`${v}%`}>
      <span className="bar">
        <span className={`fill ${tone === 'ok' ? '' : tone}`} style={{ width: `${v}%`, display: 'block' }} />
      </span>
      <span>{v}%</span>
    </span>
  );
}

export function Swatch({ color }: { color: string | null | undefined }) {
  if (!color) return <span className="nb-muted">—</span>;
  return (
    <span>
      <span className="nb-swatch" style={{ background: `#${color}` }} />
      {color}
    </span>
  );
}

export function RefLink({ value }: { value: Ref | null | undefined }) {
  if (!value) return <span className="nb-muted">—</span>;
  const dev = parentRef(value);
  return (
    <span>
      {isRef(dev) && (
        <>
          <Link to={uiHref(dev.url)}>{dev.display}</Link>
          <span className="nb-muted"> › </span>
        </>
      )}
      <Link to={uiHref(value.url)}>{value.display}</Link>
    </span>
  );
}

/** The object a component belongs to (device, virtual machine, circuit, power panel), when nested in its reference. */
export function parentRef(value: Ref): Ref | null {
  const o = value as Record<string, unknown>;
  for (const k of ['device', 'virtual_machine', 'circuit', 'power_panel']) if (isRef(o[k])) return o[k] as Ref;
  return null;
}

/** Renders any API value: refs as links, choices as chips/labels, lists, booleans, colours. */
export function Value({ v, name }: { v: unknown; name?: string }) {
  if (v == null || v === '') return <span className="nb-muted">—</span>;
  if (name === 'color' && typeof v === 'string') return <Swatch color={v} />;
  if (name === '_utilization' || name === 'utilization' || name === '_power_utilization') return <UtilBar value={v as number} />;
  if (Array.isArray(v)) {
    if (!v.length) return <span className="nb-muted">—</span>;
    if (name === 'tags')
      return (
        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
          {(v as Ref[]).map((tag) => (
            <span key={tag.id} className="nb-chip" style={{ background: `#${String(tag.color ?? 'e0e0e0')}33`, borderColor: `#${String(tag.color ?? '9e9e9e')}` }}>
              {tag.display}
            </span>
          ))}
        </span>
      );
    return (
      <span>
        {v.map((x, i) => (
          <span key={i}>
            {i > 0 && ', '}
            <Value v={x} />
          </span>
        ))}
      </span>
    );
  }
  if (isRef(v)) return <RefLink value={v} />;
  if (isChoice(v)) {
    if (name === 'status' || name === 'action') return <StatusChip value={v} />;
    return <span>{valueLabel(String(v.value), v.label)}</span>;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (isRef(o.object)) return <RefLink value={o.object} />;
    return <code style={{ fontSize: 11 }}>{JSON.stringify(v)}</code>;
  }
  if (typeof v === 'boolean') return <span>{v ? t('yes') : t('no')}</span>;
  if (name === 'created' || name === 'last_updated' || name === 'time') return <span>{new Date(String(v)).toLocaleString()}</span>;
  return <span>{String(v)}</span>;
}

export function MonitoringChip({ status }: { status: MonitoringStatus | undefined }) {
  if (!status) return <span className="nb-muted">—</span>;
  const tone: Tone = (['ok', 'info', 'warning', 'error', 'critical'] as const).includes(status.status as never) ? (status.status as Tone) : 'neutral';
  const chip = (
    <Chip tone={tone} title={status.open_alerts ? t('openAlerts', { n: status.open_alerts }) : undefined}>
      {valueLabel(status.status)}
      {status.open_alerts ? ` · ${status.open_alerts}` : ''}
    </Chip>
  );
  return status.incident_url ? (
    <a href={status.incident_url} target="_blank" rel="noreferrer" title={t('incident')}>
      {chip}
    </a>
  ) : (
    chip
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="nb-kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { key: string; label: string }[]; active: string; onChange: (k: string) => void }) {
  return (
    <div className="nb-tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.key} role="tab" aria-selected={active === tab.key} className={active === tab.key ? 'active' : ''} onClick={() => onChange(tab.key)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="nb-card">
      <h3>
        {title}
        <span className="nb-spacer" />
        {actions}
      </h3>
      <div className="body">{children}</div>
    </section>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="nb-alert">{msg}</div>;
}

/** Left navigation of object types, grouped like NetBox's menu. */
export const NAV: { group: string; items: string[] }[] = [
  { group: 'organization', items: ['dcim/regions', 'dcim/sites', 'dcim/locations', 'tenancy/tenants', 'tenancy/tenant-groups'] },
  { group: 'racks', items: ['dcim/racks', 'dcim/rack-roles'] },
  { group: 'devices', items: ['dcim/devices', 'dcim/device-roles', 'dcim/platforms', 'dcim/device-types', 'dcim/manufacturers'] },
  { group: 'templates', items: ['dcim/interface-templates', 'dcim/front-port-templates', 'dcim/rear-port-templates', 'dcim/power-port-templates', 'dcim/power-outlet-templates'] },
  { group: 'connection', items: ['dcim/interfaces', 'dcim/front-ports', 'dcim/rear-ports', 'dcim/cables'] },
  { group: 'circuits', items: ['circuits/circuits', 'circuits/circuit-terminations', 'circuits/circuit-types', 'circuits/providers', 'circuits/provider-accounts', 'circuits/provider-networks'] },
  { group: 'power', items: ['dcim/power-panels', 'dcim/power-feeds', 'dcim/power-ports', 'dcim/power-outlets'] },
  { group: 'virtualization', items: ['virtualization/virtual-machines', 'virtualization/interfaces', 'virtualization/clusters', 'virtualization/cluster-types', 'virtualization/cluster-groups'] },
  { group: 'ipam', items: ['ipam/prefixes', 'ipam/ip-ranges', 'ipam/ip-addresses', 'ipam/aggregates', 'ipam/rirs', 'ipam/vrfs', 'ipam/route-targets', 'ipam/roles'] },
  { group: 'vlans', items: ['ipam/vlans', 'ipam/vlan-groups'] },
  { group: 'other', items: ['extras/tags', 'extras/custom-fields', 'extras/object-changes'] },
];

export function Layout({ children, panel }: { children: ReactNode; panel?: ReactNode }) {
  return (
    <div className="nb">
      <nav className="nb-subnav" aria-label="DCIM / IPAM">
        <NavLink to="/dcim/search" className={({ isActive }) => (isActive ? 'active' : '')}>
          {t('search')}
        </NavLink>
        {NAV.map((g) => (
          <div key={g.group} style={{ display: 'contents' }}>
            <h4>{t(g.group)}</h4>
            {g.items.map((p) => (
              <NavLink key={p} to={`/${p}`} className={({ isActive }) => (isActive ? 'active' : '')}>
                {typeLabel(p)}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <main className="nb-main">{children}</main>
      {panel}
    </div>
  );
}

/**
 * Searchable reference picker. Loads brief objects of `model` (optionally narrowed by `params`), shows the selected
 * object(s) and a dropdown of matches.
 */
export function RefSelect({
  objectType,
  value,
  onChange,
  multiple,
  params,
  placeholder,
  id,
}: {
  objectType: string;
  value: number | number[] | null;
  onChange: (v: number | number[] | null, refs: Ref[]) => void;
  multiple?: boolean;
  params?: Record<string, string | number>;
  placeholder?: string;
  id?: string;
}) {
  const { data: schema } = useSchema();
  const model: ModelSchema | undefined = schema?.find((m) => m.object_type === objectType);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Ref[]>([]);
  const [known, setKnown] = useState<Record<number, Ref>>({});
  const box = useRef<HTMLDivElement>(null);
  const ids = value == null ? [] : Array.isArray(value) ? value : [value];
  const paramKey = JSON.stringify(params ?? {});

  useEffect(() => {
    if (!model || !open) return;
    let live = true;
    const h = setTimeout(() => {
      nb.list<Ref>(model, { brief: 1, limit: 50, q, ...(params ?? {}) }).then((p) => {
        if (!live) return;
        setOptions(p.results);
        setKnown((k) => ({ ...k, ...Object.fromEntries(p.results.map((r) => [r.id, r])) }));
      }, () => undefined);
    }, 200);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [model, q, open, paramKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve labels of preselected ids
  useEffect(() => {
    if (!model) return;
    const missing = ids.filter((i) => !known[i]);
    if (!missing.length) return;
    nb.list<Ref>(model, { brief: 1, id: missing, limit: missing.length }).then(
      (p) => setKnown((k) => ({ ...k, ...Object.fromEntries(p.results.map((r) => [r.id, r])) })),
      () => undefined,
    );
  }, [model, ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const label = (r: Ref) => {
    const dev = parentRef(r);
    return dev ? `${dev.display} › ${r.display}` : r.display;
  };
  const pick = (r: Ref) => {
    if (multiple) {
      const next = ids.includes(r.id) ? ids.filter((i) => i !== r.id) : [...ids, r.id];
      onChange(next, next.map((i) => known[i] ?? r));
    } else {
      onChange(r.id, [r]);
      setOpen(false);
      setQ('');
    }
  };

  return (
    <div ref={box} style={{ position: 'relative' }}>
      {multiple && ids.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
          {ids.map((i) => (
            <span key={i} className="nb-chip info">
              {known[i] ? label(known[i]) : `#${i}`}{' '}
              <button type="button" className="nb-btn" style={{ padding: '0 4px', lineHeight: 1 }} onClick={() => onChange(ids.filter((x) => x !== i), [])} aria-label={t('delete')}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          id={id}
          className="nb-input"
          style={{ flex: 1 }}
          placeholder={!multiple && ids[0] != null ? (known[ids[0]] ? label(known[ids[0]]) : `#${ids[0]}`) : (placeholder ?? t('filterOptions'))}
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
        />
        {!multiple && ids[0] != null && (
          <button type="button" className="nb-btn" onClick={() => onChange(null, [])} title={t('none')}>
            ×
          </button>
        )}
      </div>
      {!multiple && ids[0] != null && !open && <div style={{ fontSize: 12 }}>{known[ids[0]] ? label(known[ids[0]]) : `#${ids[0]}`}</div>}
      {open && (
        <div
          role="listbox"
          style={{ position: 'absolute', zIndex: 40, left: 0, right: 0, maxHeight: 240, overflowY: 'auto', background: '#fff', border: '1px solid var(--nb-border)', borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,.15)' }}
        >
          {options.length === 0 && <div className="nb-empty">{t('noResults')}</div>}
          {options.map((r) => (
            <div
              key={r.id}
              role="option"
              aria-selected={ids.includes(r.id)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(r);
              }}
              style={{ padding: '4px 8px', cursor: 'pointer', background: ids.includes(r.id) ? 'var(--nb-row-hover)' : undefined }}
            >
              {label(r)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
