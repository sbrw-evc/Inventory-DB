import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, nb, request, toQuery, type ModelSchema, type NbObject, type Page, type Ref } from './api';
import { Card, ErrorBox, KV, Layout, MonitoringChip, RefLink, StatusChip, uiHref, UtilBar, Value } from './components';
import { objectRoute } from './config';
import { DetailShell, type DetailContext } from './DetailShell';
import { compareAddr, contrastText, elevationBlocks, isRef, type ElevationUnit } from './format';
import { findModel, useAsync, useMonitoring, useSchema } from './hooks';
import { fieldLabel, t, typeLabel } from './i18n';
import { DeviceComponents, RackPowerCard } from './morePages';

type SearchHit = Awaited<ReturnType<typeof nb.search>>['results'][number];

export const fetchList = (path: string, params: Record<string, string | number | undefined>) => request<Page>('GET', `${path}${toQuery({ limit: 1000, ...params })}`);

/** Compact table of objects with the first column linking to the object. */
export function MiniTable({ rows, columns, link, empty }: { rows: NbObject[]; columns: string[]; link?: (o: NbObject) => string; empty?: ReactNode }) {
  if (!rows.length) return <div className="nb-muted">{empty ?? t('noResults')}</div>;
  return (
    <div className="nb-table-wrap">
      <table className="nb-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{fieldLabel(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              {columns.map((c, i) => (
                <td key={c}>{i === 0 ? <Link to={link ? link(o) : uiHref(o.url)}>{o[c] != null && typeof o[c] !== 'object' ? String(o[c]) : o.display}</Link> : <Value v={o[c]} name={c} />}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** KV rows for the given fields of an object (skips empty values). */
export const kvRows = (obj: NbObject, keys: string[]): [string, ReactNode][] =>
  keys.filter((k) => obj[k] != null && obj[k] !== '' && !(Array.isArray(obj[k]) && !(obj[k] as unknown[]).length)).map((k) => [fieldLabel(k), <Value key={k} v={obj[k]} name={k} />]);

// --------------------------------------------------------------------------------------------------------------
// Site

export function SitePage() {
  return (
    <DetailShell objectType="dcim.site">
      {({ obj }) => <SiteBody site={obj} />}
    </DetailShell>
  );
}

function SiteBody({ site }: { site: NbObject }) {
  const racks = useAsync(() => fetchList('/dcim/racks', { site_id: site.id }), [site.id]);
  const devices = useAsync(() => fetchList('/dcim/devices', { site_id: site.id, limit: 100 }), [site.id]);
  const tiles: [string, number, string][] = [
    ['location_count', Number(site.location_count ?? 0), `/dcim/locations?site_id=${site.id}`],
    ['rack_count', Number(site.rack_count ?? 0), `/dcim/racks?site_id=${site.id}`],
    ['device_count', Number(site.device_count ?? 0), `/dcim/devices?site_id=${site.id}`],
    ['prefix_count', Number(site.prefix_count ?? 0), `/ipam/prefixes?site_id=${site.id}`],
    ['vlan_count', Number(site.vlan_count ?? 0), `/ipam/vlans?site_id=${site.id}`],
  ];
  return (
    <>
      <div className="nb-counters">
        {tiles.map(([k, n, to]) => (
          <Link key={k} to={to} className="nb-counter info" style={{ color: 'inherit', textDecoration: 'none' }}>
            <b>{n}</b>
            {fieldLabel(k)}
          </Link>
        ))}
      </div>
      <div className="nb-grid">
        <Card title={t('details')}>
          <KV rows={kvRows(site, ['region', 'tenant', 'facility', 'time_zone', 'physical_address', 'shipping_address', 'latitude', 'longitude', 'description', 'comments', 'tags'])} />
        </Card>
        <Card title={t('racks')} actions={<Link to={`/dcim/racks?site_id=${site.id}`}>{t('objects')} →</Link>}>
          <ErrorBox error={racks.error} />
          <MiniTable rows={racks.data?.results ?? []} columns={['name', 'location', 'status', 'u_height', 'device_count', '_utilization']} />
        </Card>
      </div>
      <div style={{ marginTop: 12 }}>
        <Card title={t('devices')} actions={<Link to={`/dcim/devices?site_id=${site.id}`}>{t('objects')} →</Link>}>
          <MiniTable rows={devices.data?.results ?? []} columns={['name', 'status', 'role', 'device_type', 'rack', 'position', 'primary_ip']} />
        </Card>
      </div>
    </>
  );
}

// --------------------------------------------------------------------------------------------------------------
// Rack elevation

const UNIT_H = 22;
const LABEL_W = 34;
const RACK_W = 230;

export function RackElevation({ rackId, face, onPick }: { rackId: number; face: 'front' | 'rear'; onPick: (deviceId: number) => void }) {
  const { data, error } = useAsync(() => request<Page<ElevationUnit>>('GET', `/dcim/racks/${rackId}/elevation?face=${face}`), [rackId, face]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="nb-muted">{t('loading')}</div>;
  const units = data.results;
  const blocks = elevationBlocks(units);
  const height = units.length * UNIT_H + 2;
  return (
    <figure className="nb-rack" style={{ margin: 0 }}>
      <figcaption style={{ fontWeight: 'bold', marginBottom: 6, textAlign: 'center' }}>{face === 'front' ? t('front') : t('rear')}</figcaption>
      <svg width={LABEL_W + RACK_W + 2} height={height} viewBox={`0 0 ${LABEL_W + RACK_W + 2} ${height}`} role="img" aria-label={`${t('elevation')} ${face}`}>
        <rect x={LABEL_W} y={0} width={RACK_W + 2} height={height} fill="#555" rx={3} />
        {units.map((u, i) => (
          <text key={u.id} className="unit-label" x={LABEL_W - 4} y={i * UNIT_H + UNIT_H / 2 + 4} textAnchor="end">
            {u.id}
          </text>
        ))}
        {blocks.map((b) => {
          const y = 1 + b.row * UNIT_H;
          const h = b.span * UNIT_H - 1;
          if (!b.device) return <rect key={`e${b.row}`} className="slot" x={LABEL_W + 1} y={y} width={RACK_W} height={h} />;
          const color = b.device.role_color ?? '9e9e9e';
          return (
            <g key={`d${b.row}`} className="device" onClick={() => onPick(b.device!.id)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onPick(b.device!.id)}>
              <title>{`${b.device.display} (U${b.device.position}${b.device.u_height > 1 ? `–${b.device.position + b.device.u_height - 1}` : ''})`}</title>
              <rect x={LABEL_W + 1} y={y} width={RACK_W} height={h} fill={`#${color}`} rx={2} />
              <text x={LABEL_W + 1 + RACK_W / 2} y={y + h / 2 + 4} textAnchor="middle" fill={contrastText(color)}>
                {b.device.display.length > 30 ? `${b.device.display.slice(0, 29)}…` : b.device.display}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export function RackPage() {
  const navigate = useNavigate();
  return (
    <DetailShell objectType="dcim.rack">
      {({ obj, canWrite, openCreate }) => (
        <>
          <div className="nb-grid" style={{ gridTemplateColumns: 'minmax(280px, 1fr) auto' }}>
            <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
              <Card title={t('details')}>
                <KV rows={[...kvRows(obj, ['site', 'location', 'facility_id', 'tenant', 'role', 'serial', 'asset_tag', 'form_factor', 'width', 'u_height', 'description', 'tags']), [t('utilization'), <UtilBar key="u" value={obj._utilization as number} />]]} />
              </Card>
              <NonRacked rack={obj} />
              <RackPowerCard rack={obj} />
            </div>
            <Card
              title={t('elevation')}
              actions={
                canWrite && (
                  <button className="nb-btn" onClick={() => openCreate('dcim.device', { site: (obj.site as Ref).id, rack: obj.id, face: 'front' })}>
                    + {t('add')}
                  </button>
                )
              }
            >
              <div className="nb-racks">
                <RackElevation key={`f${String(obj.last_updated)}`} rackId={obj.id} face="front" onPick={(id) => navigate(`/dcim/devices/${id}`)} />
                <RackElevation key={`r${String(obj.last_updated)}`} rackId={obj.id} face="rear" onPick={(id) => navigate(`/dcim/devices/${id}`)} />
              </div>
            </Card>
          </div>
        </>
      )}
    </DetailShell>
  );
}

function NonRacked({ rack }: { rack: NbObject }) {
  const { data } = useAsync(() => fetchList('/dcim/devices', { rack_id: rack.id, ordering: 'name' }), [rack.id, rack.last_updated]);
  const rows = (data?.results ?? []).filter((d) => d.position == null);
  return (
    <Card title={t('nonRacked')}>
      <MiniTable rows={rows} columns={['name', 'status', 'role', 'device_type']} empty="—" />
    </Card>
  );
}

// --------------------------------------------------------------------------------------------------------------
// Device

export function DevicePage() {
  return (
    <DetailShell objectType="dcim.device" extra={({ obj }) => <DeviceMonitoring id={obj.id} />}>
      {(ctx) => <DeviceBody ctx={ctx} />}
    </DetailShell>
  );
}

function DeviceMonitoring({ id }: { id: number }) {
  const status = useMonitoring('dcim.device', [id]);
  if (!status) return null;
  return (
    <span title={t('monitoring')}>
      <MonitoringChip status={status.get(id)} />
    </span>
  );
}

function DeviceBody({ ctx }: { ctx: DetailContext }) {
  const { obj, canWrite, openCreate } = ctx;
  const ifaces = useAsync(() => fetchList('/dcim/interfaces', { device_id: obj.id, ordering: 'name' }), [obj.id, obj.last_updated]);
  const ips = useAsync(() => fetchList('/ipam/ip-addresses', { device_id: obj.id }), [obj.id, obj.last_updated]);
  const ipsByIface = new Map<number, NbObject[]>();
  for (const ip of ips.data?.results ?? []) {
    const a = ip.assigned_object as Ref | null;
    if (a) ipsByIface.set(a.id, [...(ipsByIface.get(a.id) ?? []), ip]);
  }
  const rack = obj.rack as Ref | null;
  return (
    <>
      <div className="nb-grid">
        <Card title={t('details')}>
          <KV
            rows={[
              ...kvRows(obj, ['site', 'location', 'rack']),
              ...(rack && obj.position != null ? ([[fieldLabel('position'), `U${String(obj.position)} · ${(obj.face as { label: string } | null)?.label ?? ''}`]] as [string, ReactNode][]) : []),
              ...kvRows(obj, ['role', 'device_type', 'platform', 'cluster', 'tenant', 'serial', 'asset_tag', 'primary_ip4', 'primary_ip6', 'description', 'comments', 'tags']),
            ]}
          />
        </Card>
        <Card
          title={t('ipAddresses')}
          actions={
            canWrite && (
              <button className="nb-btn" onClick={() => openCreate('ipam.ipaddress', {})}>
                + {t('add')}
              </button>
            )
          }
        >
          <MiniTable rows={ips.data?.results ?? []} columns={['address', 'status', 'assigned_object', 'vrf', 'dns_name']} empty="—" />
        </Card>
      </div>
      <div style={{ marginTop: 12 }}>
        <Card
          title={`${t('interfaces')} (${ifaces.data?.count ?? 0})`}
          actions={
            canWrite && (
              <button className="nb-btn" onClick={() => openCreate('dcim.interface', { device: obj.id, type: '1000base-t' })}>
                + {t('add')}
              </button>
            )
          }
        >
          <ErrorBox error={ifaces.error} />
          <div className="nb-table-wrap">
            <table className="nb-table">
              <thead>
                <tr>
                  {['name', 'type', 'enabled', 'lag', 'mtu', 'mode', 'ipAddresses', 'cable', 'connection'].map((c) => (
                    <th key={c}>{c === 'ipAddresses' || c === 'connection' ? t(c) : fieldLabel(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(ifaces.data?.results ?? []).map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link to={`/dcim/interfaces/${i.id}`}>{i.display}</Link>
                      {i.mgmt_only ? <span className="nb-muted"> ({t('mgmt')})</span> : null}
                    </td>
                    <td>
                      <Value v={i.type} />
                    </td>
                    <td>
                      <Value v={i.enabled} />
                    </td>
                    <td>
                      <Value v={i.lag} />
                    </td>
                    <td>
                      <Value v={i.mtu} />
                    </td>
                    <td>
                      <Value v={i.mode} />
                    </td>
                    <td>
                      {(ipsByIface.get(i.id) ?? []).map((ip) => (
                        <div key={ip.id}>
                          <Link to={uiHref(ip.url)}>{ip.display}</Link>
                        </div>
                      ))}
                    </td>
                    <td>{i.cable ? <Link to={`/dcim/interfaces/${i.id}/trace`}>{(i.cable as Ref).display}</Link> : <span className="nb-muted">—</span>}</td>
                    <td>
                      <Value v={i.link_peers} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <DeviceComponents device={obj} canWrite={canWrite} openCreate={openCreate} />
    </>
  );
}

// --------------------------------------------------------------------------------------------------------------
// Prefix

export function PrefixPage() {
  return <DetailShell objectType="ipam.prefix">{(ctx) => <PrefixBody ctx={ctx} />}</DetailShell>;
}

function PrefixBody({ ctx }: { ctx: DetailContext }) {
  const { obj, canWrite, reload } = ctx;
  const vrf = obj.vrf as Ref | null;
  const depth = Number(obj._depth ?? 0);
  const prefix = String(obj.prefix);
  const family = Number((obj.family as { value: number }).value);
  const isContainer = (obj.status as { value: string } | null)?.value === 'container';
  const children = useAsync(() => fetchList('/ipam/prefixes', { parent: prefix, vrf_id: vrf?.id ?? 'null' }), [obj.id, obj.last_updated]);
  const available = useAsync(() => request<{ prefix: string }[]>('GET', `/ipam/prefixes/${obj.id}/available-prefixes`), [obj.id, obj.last_updated]);
  const ips = useAsync(() => fetchList('/ipam/ip-addresses', { parent: prefix, vrf_id: vrf?.id ?? 'null' }), [obj.id, obj.last_updated]);
  const freeIps = useAsync(() => request<{ address: string }[]>('GET', `/ipam/prefixes/${obj.id}/available-ips?limit=5`), [obj.id, obj.last_updated]);
  const [msg, setMsg] = useState<{ tone: string; text: ReactNode } | null>(null);
  const plen = Number(String(obj.prefix).split('/')[1]);
  const [allocLen, setAllocLen] = useState(Math.min(plen + (family === 4 ? 2 : 16), family === 4 ? 32 : 128));

  // children (indented by relative depth) merged with available blocks, sorted by network
  const rows: { key: string; prefix: string; depth: number; obj?: NbObject }[] = [
    ...(children.data?.results ?? []).map((c) => ({ key: `p${c.id}`, prefix: String(c.prefix), depth: Number(c._depth ?? 0) - depth - 1, obj: c })),
    ...(available.data ?? []).map((a) => ({ key: `a${a.prefix}`, prefix: a.prefix, depth: 0 })),
  ].sort((a, b) => compareAddr(a.prefix, b.prefix));

  async function allocate(kind: 'ip' | 'prefix') {
    try {
      const created =
        kind === 'ip'
          ? await request<NbObject>('POST', `/ipam/prefixes/${obj.id}/available-ips`, {})
          : await request<NbObject>('POST', `/ipam/prefixes/${obj.id}/available-prefixes`, { prefix_length: allocLen });
      setMsg({ tone: 'ok', text: <>{t('allocated', { what: '' })}<Link to={uiHref(created.url)}>{created.display}</Link></> });
      reload();
    } catch (e) {
      setMsg({ tone: '', text: e instanceof ApiError ? e.message : String(e) });
    }
  }

  return (
    <>
      {msg && <div className={`nb-alert ${msg.tone}`}>{msg.text}</div>}
      <div className="nb-grid">
        <Card title={t('details')}>
          <KV
            rows={[
              ...kvRows(obj, ['family', 'vrf', 'scope', 'site', 'vlan', 'role', 'tenant', 'is_pool', 'mark_utilized', 'description', 'tags']),
              [t('utilization'), <UtilBar key="u" value={obj._utilization as number} />],
              [fieldLabel('_children'), String(obj._children ?? 0)],
            ]}
          />
        </Card>
        <Card title={isContainer ? t('availablePrefixes') : t('availableIps')}>
          {isContainer ? (
            <div style={{ display: 'grid', gap: 4 }}>
              {(available.data ?? []).slice(0, 5).map((a) => (
                <code key={a.prefix}>{a.prefix}</code>
              ))}
            </div>
          ) : (freeIps.data ?? []).length ? (
            <div style={{ display: 'grid', gap: 4 }}>
              {freeIps.data!.map((a) => (
                <code key={a.address}>{a.address}</code>
              ))}
            </div>
          ) : (
            <div className="nb-muted">{t('none')}</div>
          )}
          {canWrite && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {!isContainer && (
                <button className="nb-btn primary" onClick={() => allocate('ip')} disabled={!freeIps.data?.length}>
                  {t('nextIp')}
                </button>
              )}
              <select value={allocLen} onChange={(e) => setAllocLen(Number(e.target.value))} aria-label={fieldLabel('prefix')}>
                {Array.from({ length: (family === 4 ? 32 : 128) - plen }, (_, i) => plen + 1 + i).map((n) => (
                  <option key={n} value={n}>
                    /{n}
                  </option>
                ))}
              </select>
              <button className="nb-btn" onClick={() => allocate('prefix')} disabled={!available.data?.length}>
                {t('allocatePrefix', { n: allocLen })}
              </button>
            </div>
          )}
        </Card>
      </div>
      <div style={{ marginTop: 12 }}>
        <Card title={`${t('childPrefixes')} (${children.data?.count ?? 0})`}>
          <div className="nb-table-wrap">
            <table className="nb-table">
              <thead>
                <tr>
                  {['prefix', 'status', '_children', 'vlan', 'site', '_utilization', 'description'].map((c) => (
                    <th key={c}>{fieldLabel(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) =>
                  r.obj ? (
                    <tr key={r.key}>
                      <td>
                        <span className="nb-tree-indent">{'· '.repeat(Math.max(0, r.depth))}</span>
                        <Link to={`/ipam/prefixes/${r.obj.id}`}>{r.prefix}</Link>
                      </td>
                      <td>
                        <StatusChip value={r.obj.status as never} />
                      </td>
                      <td>{String(r.obj._children ?? 0)}</td>
                      <td>
                        <Value v={r.obj.vlan} />
                      </td>
                      <td>
                        <Value v={r.obj.site} />
                      </td>
                      <td>
                        <UtilBar value={r.obj._utilization as number} />
                      </td>
                      <td>
                        <Value v={r.obj.description} />
                      </td>
                    </tr>
                  ) : (
                    <tr key={r.key} style={{ background: 'var(--ok-bg, #d5e8d4)' }}>
                      <td>{r.prefix}</td>
                      <td colSpan={6}>
                        <span className="nb-chip ok">{t('available')}</span>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <div style={{ marginTop: 12 }}>
        <Card title={`${t('ipAddresses')} (${ips.data?.count ?? 0})`} actions={<Link to={`/ipam/ip-addresses?parent=${encodeURIComponent(prefix)}`}>{t('objects')} →</Link>}>
          <MiniTable rows={ips.data?.results ?? []} columns={['address', 'status', 'role', 'assigned_object', 'dns_name', 'description']} empty="—" />
        </Card>
      </div>
    </>
  );
}

// --------------------------------------------------------------------------------------------------------------
// Search and overview

export function SearchPage() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const { data, error, loading } = useAsync(() => (q ? nb.search(q) : Promise.resolve({ count: 0, results: [] })), [q]);
  const groups = new Map<string, SearchHit[]>();
  for (const r of data?.results ?? []) groups.set(r.object_type, [...(groups.get(r.object_type) ?? []), r]);
  const { data: schema } = useSchema();
  return (
    <Layout>
      <div className="nb-title">
        <h1>{t('globalSearch')}</h1>
      </div>
      <div className="nb-toolbar">
        <input
          className="nb-input nb-search"
          type="search"
          autoFocus
          defaultValue={q}
          placeholder={t('searchPlaceholder')}
          aria-label={t('search')}
          onKeyDown={(e) => e.key === 'Enter' && setSp({ q: (e.target as HTMLInputElement).value })}
        />
        <button className="nb-btn primary" onClick={(e) => setSp({ q: ((e.currentTarget.previousSibling as HTMLInputElement | null)?.value ?? '').trim() })}>
          {t('search')}
        </button>
      </div>
      <ErrorBox error={error} />
      {loading && q && <div className="nb-muted">{t('loading')}</div>}
      {q && !loading && !data?.results.length && <div className="nb-empty">{t('noResults')}</div>}
      <div className="nb-grid">
        {[...groups].map(([type, results]) => {
          const m = findModel(schema, type);
          return (
            <Card key={type} title={`${m ? typeLabel(`${m.app}/${m.path}`, m.verbose_name_plural) : type} (${results.length})`} actions={m && <Link to={`${objectRoute(m.app, m.path)}?q=${encodeURIComponent(q)}`}>{t('objects')} →</Link>}>
              {results.map((r) => (
                <div key={r.id} style={{ padding: '2px 0' }}>
                  <RefLink value={r} />
                </div>
              ))}
            </Card>
          );
        })}
      </div>
    </Layout>
  );
}

const SECTION_TYPES: Record<string, string[]> = {
  dcim: ['dcim/sites', 'dcim/locations', 'dcim/racks', 'dcim/devices', 'dcim/interfaces', 'dcim/front-ports', 'dcim/rear-ports', 'dcim/cables', 'dcim/power-panels', 'dcim/power-feeds', 'dcim/device-types', 'dcim/manufacturers', 'tenancy/tenants'],
  circuits: ['circuits/circuits', 'circuits/circuit-terminations', 'circuits/providers', 'circuits/provider-networks', 'circuits/circuit-types'],
  virtualization: ['virtualization/virtual-machines', 'virtualization/interfaces', 'virtualization/clusters', 'virtualization/cluster-groups', 'virtualization/cluster-types'],
  ipam: ['ipam/aggregates', 'ipam/prefixes', 'ipam/ip-ranges', 'ipam/ip-addresses', 'ipam/vrfs', 'ipam/vlans', 'ipam/vlan-groups'],
};

export function SectionHome({ section }: { section: 'dcim' | 'ipam' | 'circuits' | 'virtualization' }) {
  const { data: schema } = useSchema();
  const types = SECTION_TYPES[section];
  const counts = useAsync(async () => {
    if (!schema) return {};
    const entries = await Promise.all(
      types.map(async (k) => {
        const m = findModel(schema, k) as ModelSchema | undefined;
        return [k, m ? (await nb.list(m, { limit: 1 })).count : 0] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<string, number>;
  }, [schema, section]);
  return (
    <Layout>
      <div className="nb-title">
        <h1>
          {t(section)} · {t('overview')}
        </h1>
      </div>
      <ErrorBox error={counts.error} />
      <div className="nb-counters">
        {types.map((k) => (
          <Link key={k} to={`/${k}`} className="nb-counter info" style={{ color: 'inherit', textDecoration: 'none', minWidth: 140 }}>
            <b>{counts.data?.[k] ?? '…'}</b>
            {typeLabel(k)}
          </Link>
        ))}
      </div>
    </Layout>
  );
}
