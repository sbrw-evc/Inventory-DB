/** Pages and cards for circuits, power, device components, virtualization and cable traces. */
import { Link, useParams } from 'react-router-dom';
import { request, type NbObject, type Ref } from './api';
import { Card, ErrorBox, KV, Layout, parentRef, RefLink, StatusChip, uiHref, UtilBar, Value } from './components';
import { DetailShell, type DetailContext } from './DetailShell';
import { useAsync } from './hooks';
import { fieldLabel, t, typeLabel, valueLabel } from './i18n';
import { fetchList, kvRows, MiniTable } from './pages';

// --------------------------------------------------------------------------------------------------------------
// Rack power

interface RackPowerSummary {
  feeds: { feed: Ref; status: { value: string; label: string }; type: { value: string; label: string }; available_power: number; allocated_draw: number; maximum_draw: number; utilization: number }[];
  available_power: number;
  allocated_draw: number;
  maximum_draw: number;
  utilization: number;
  device_power_ports: number;
  device_allocated_draw: number;
}

export function RackPowerCard({ rack }: { rack: NbObject }) {
  const { data, error } = useAsync(() => request<RackPowerSummary>('GET', `/dcim/racks/${rack.id}/power`), [rack.id, rack.last_updated]);
  return (
    <Card title={t('powerUtilization')} actions={<Link to={`/dcim/power-feeds?rack_id=${rack.id}`}>{t('powerFeeds')} →</Link>}>
      <ErrorBox error={error} />
      {data && (
        <>
          <KV
            rows={[
              [t('powerUtilization'), <UtilBar key="u" value={data.utilization} />],
              [t('availablePower'), `${data.available_power} VA`],
              [t('allocatedDraw'), `${data.allocated_draw} W`],
              [t('maximumDraw'), `${data.maximum_draw} W`],
              [t('devicesDraw'), `${data.device_allocated_draw} W (${data.device_power_ports})`],
            ]}
          />
          {data.feeds.length ? (
            <div className="nb-table-wrap" style={{ marginTop: 8 }}>
              <table className="nb-table">
                <thead>
                  <tr>
                    {['power_feed', 'type', 'available_power', 'allocated_draw', '_utilization'].map((c) => (
                      <th key={c}>{fieldLabel(c)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.feeds.map((f) => (
                    <tr key={f.feed.id}>
                      <td>
                        <Link to={uiHref(f.feed.url)}>{f.feed.display}</Link> <StatusChip value={f.status} />
                      </td>
                      <td>{valueLabel(f.type.value, f.type.label)}</td>
                      <td>{f.available_power}</td>
                      <td>{f.allocated_draw}</td>
                      <td>
                        <UtilBar value={f.utilization} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="nb-muted" style={{ marginTop: 8 }}>
              {t('noPowerFeeds')}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// --------------------------------------------------------------------------------------------------------------
// Device components

const COMPONENTS: { key: string; path: string; type: string; count: string; columns: string[]; presets?: Record<string, unknown> }[] = [
  { key: 'frontPorts', path: 'front-ports', type: 'dcim.frontport', count: 'front_port_count', columns: ['name', 'type', 'rear_port', 'rear_port_position', 'cable', 'link_peers'], presets: { type: '8p8c' } },
  { key: 'rearPorts', path: 'rear-ports', type: 'dcim.rearport', count: 'rear_port_count', columns: ['name', 'type', 'positions', 'cable', 'link_peers'], presets: { type: '8p8c' } },
  { key: 'powerPorts', path: 'power-ports', type: 'dcim.powerport', count: 'power_port_count', columns: ['name', 'type', 'maximum_draw', 'allocated_draw', 'cable', 'connected_endpoints'] },
  { key: 'powerOutlets', path: 'power-outlets', type: 'dcim.poweroutlet', count: 'power_outlet_count', columns: ['name', 'type', 'power_port', 'feed_leg', 'cable', 'link_peers'] },
];

/** Front/rear ports and power ports/outlets of a device: one card per kind the device has. */
export function DeviceComponents({ device, canWrite, openCreate }: { device: NbObject; canWrite: boolean; openCreate: DetailContext['openCreate'] }) {
  const lists = useAsync(
    () => Promise.all(COMPONENTS.map((c) => (Number(device[c.count] ?? 0) > 0 ? fetchList(`/dcim/${c.path}`, { device_id: device.id, ordering: 'name' }) : Promise.resolve(null)))),
    [device.id, device.last_updated],
  );
  return (
    <>
      {COMPONENTS.map((c, i) => {
        const page = lists.data?.[i];
        if (!page) return null;
        return (
          <div key={c.key} style={{ marginTop: 12 }}>
            <Card
              title={`${t(c.key)} (${page.count})`}
              actions={
                <>
                  {canWrite && (
                    <button className="nb-btn" onClick={() => openCreate(c.type, { device: device.id, ...c.presets })}>
                      + {t('add')}
                    </button>
                  )}
                  <Link to={`/dcim/${c.path}?device_id=${device.id}`}>{t('objects')} →</Link>
                </>
              }
            >
              <MiniTable rows={page.results} columns={c.columns} link={(o) => `/dcim/${c.path}?device_id=${device.id}&_sel=${o.id}`} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                {page.results
                  .filter((o) => o.cable)
                  .map((o) => (
                    <Link key={o.id} to={`/dcim/${c.path}/${o.id}/trace`}>
                      {t('trace')}: {o.display}
                    </Link>
                  ))}
              </div>
            </Card>
          </div>
        );
      })}
    </>
  );
}

// --------------------------------------------------------------------------------------------------------------
// Circuits

export function CircuitPage() {
  return <DetailShell objectType="circuits.circuit">{(ctx) => <CircuitBody ctx={ctx} />}</DetailShell>;
}

function CircuitBody({ ctx }: { ctx: DetailContext }) {
  const { obj, canWrite, openCreate } = ctx;
  const terms = useAsync(() => fetchList('/circuits/circuit-terminations', { circuit_id: obj.id }), [obj.id, obj.last_updated]);
  return (
    <div className="nb-grid">
      <Card title={t('details')}>
        <KV rows={kvRows(obj, ['provider', 'provider_account', 'type', 'tenant', 'install_date', 'termination_date', 'commit_rate', 'description', 'comments', 'tags'])} />
      </Card>
      {(['A', 'Z'] as const).map((side) => {
        const term = terms.data?.results.find((x) => (x.term_side as { value: string } | null)?.value === side);
        return (
          <Card
            key={side}
            title={t(side === 'A' ? 'terminationA' : 'terminationZ')}
            actions={
              term ? (
                <Link to={`/circuits/circuit-terminations?circuit_id=${obj.id}&_sel=${term.id}`}>{t('edit')} →</Link>
              ) : (
                canWrite && (
                  <button className="nb-btn" onClick={() => openCreate('circuits.circuittermination', { circuit: obj.id, term_side: side })}>
                    + {t('addTermination', { side })}
                  </button>
                )
              )
            }
          >
            {term ? (
              <>
                <KV rows={kvRows(term, ['site', 'provider_network', 'port_speed', 'upstream_speed', 'xconnect_id', 'pp_info', 'description', 'cable', 'link_peers', 'connected_endpoints'])} />
                {!!term.cable && (
                  <div style={{ marginTop: 6 }}>
                    <Link to={`/circuits/circuit-terminations/${term.id}/trace`}>{t('trace')} →</Link>
                  </div>
                )}
              </>
            ) : (
              <div className="nb-muted">{t('none')}</div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// --------------------------------------------------------------------------------------------------------------
// Virtualization

export function ClusterPage() {
  return <DetailShell objectType="virtualization.cluster">{(ctx) => <ClusterBody ctx={ctx} />}</DetailShell>;
}

function ClusterBody({ ctx }: { ctx: DetailContext }) {
  const { obj: cluster, canWrite, openCreate } = ctx;
  const vms = useAsync(() => fetchList('/virtualization/virtual-machines', { cluster_id: cluster.id }), [cluster.id, cluster.last_updated]);
  const devices = useAsync(() => fetchList('/dcim/devices', { cluster_id: cluster.id }), [cluster.id, cluster.last_updated]);
  return (
    <>
      <div className="nb-grid">
        <Card title={t('details')}>
          <KV rows={kvRows(cluster, ['type', 'group', 'site', 'tenant', 'description', 'comments', 'tags'])} />
        </Card>
        <Card title={`${t('hosts')} (${devices.data?.count ?? 0})`}>
          <MiniTable rows={devices.data?.results ?? []} columns={['name', 'status', 'role', 'device_type', 'primary_ip']} empty="—" />
        </Card>
      </div>
      <div style={{ marginTop: 12 }}>
        <Card
          title={`${t('virtualMachines')} (${vms.data?.count ?? 0})`}
          actions={
            canWrite && (
              <button className="nb-btn" onClick={() => openCreate('virtualization.virtualmachine', { cluster: cluster.id })}>
                + {t('add')}
              </button>
            )
          }
        >
          <ErrorBox error={vms.error} />
          <MiniTable rows={vms.data?.results ?? []} columns={['name', 'status', 'role', 'vcpus', 'memory', 'disk', 'primary_ip']} empty="—" />
        </Card>
      </div>
    </>
  );
}

export function VirtualMachinePage() {
  return <DetailShell objectType="virtualization.virtualmachine">{(ctx) => <VmBody ctx={ctx} />}</DetailShell>;
}

function VmBody({ ctx }: { ctx: DetailContext }) {
  const { obj, canWrite, openCreate } = ctx;
  const ifaces = useAsync(() => fetchList('/virtualization/interfaces', { virtual_machine_id: obj.id, ordering: 'name' }), [obj.id, obj.last_updated]);
  const ips = useAsync(() => fetchList('/ipam/ip-addresses', { virtual_machine_id: obj.id }), [obj.id, obj.last_updated]);
  const ipsByIface = new Map<number, NbObject[]>();
  for (const ip of ips.data?.results ?? []) {
    const a = ip.assigned_object as Ref | null;
    if (a) ipsByIface.set(a.id, [...(ipsByIface.get(a.id) ?? []), ip]);
  }
  const cols = ['enabled', 'parent', 'mtu', 'mac_address', 'mode'];
  return (
    <>
      <div className="nb-grid">
        <Card title={t('details')}>
          <KV rows={kvRows(obj, ['site', 'cluster', 'device', 'role', 'platform', 'tenant', 'vcpus', 'memory', 'disk', 'primary_ip4', 'primary_ip6', 'serial', 'description', 'comments', 'tags'])} />
        </Card>
        <Card
          title={t('ipAddresses')}
          actions={
            canWrite && (
              <button className="nb-btn" onClick={() => openCreate('ipam.ipaddress', { assigned_object_type: 'virtualization.vminterface' })}>
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
              <button className="nb-btn" onClick={() => openCreate('virtualization.vminterface', { virtual_machine: obj.id })}>
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
                  <th>{fieldLabel('name')}</th>
                  {cols.map((c) => (
                    <th key={c}>{fieldLabel(c)}</th>
                  ))}
                  <th>{t('ipAddresses')}</th>
                </tr>
              </thead>
              <tbody>
                {(ifaces.data?.results ?? []).map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link to={`/virtualization/interfaces?virtual_machine_id=${obj.id}&_sel=${i.id}`}>{i.display}</Link>
                    </td>
                    {cols.map((c) => (
                      <td key={c}>
                        <Value v={i[c]} name={c} />
                      </td>
                    ))}
                    <td>
                      {(ipsByIface.get(i.id) ?? []).map((ip) => (
                        <div key={ip.id}>
                          <Link to={uiHref(ip.url)}>{ip.display}</Link>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}

// --------------------------------------------------------------------------------------------------------------
// Cable trace

type TraceSegment = [NbObject[], NbObject | null, NbObject[]];

function TraceEnd({ ends }: { ends: NbObject[] }) {
  return (
    <div className="end">
      {ends.map((e) => {
        const parent = parentRef(e);
        return (
          <div key={e.url}>
            <div className="dev">{parent ? <Link to={uiHref(parent.url)}>{parent.display}</Link> : '—'}</div>
            <div>
              <Link to={e.display_url ?? uiHref(e.url)}>{e.display}</Link> <span className="nb-muted">{(e.type as { label?: string } | null)?.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Cable trace of any cable termination: `/dcim/<interfaces|front-ports|rear-ports|power-ports|power-outlets|power-feeds>/:id/trace`
 * or `/circuits/circuit-terminations/:id/trace`. Each hop shows near ends, the cable and far ends; front/rear ports and
 * circuits continue the path in the next hop.
 */
export function TracePage({ app }: { app: string }) {
  const { id = '', path = 'interfaces' } = useParams();
  const base = `/${app}/${path}`;
  const origin = useAsync(() => request<NbObject>('GET', `${base}/${id}`), [base, id]);
  const trace = useAsync(() => request<TraceSegment[]>('GET', `${base}/${id}/trace`), [base, id]);
  return (
    <Layout>
      <div className="nb-breadcrumb">
        <Link to={base}>{typeLabel(`${app}/${path}`)}</Link> / {origin.data && <RefLink value={origin.data} />}
      </div>
      <div className="nb-title">
        <h1>{t('cableTrace')}</h1>
      </div>
      <ErrorBox error={origin.error ?? trace.error} />
      {trace.data && trace.data.length === 0 && origin.data && (
        <div className="nb-trace">
          <TraceEnd ends={[origin.data]} />
          <div className="nb-muted" style={{ marginTop: 12 }}>
            {t('notConnected')}
          </div>
        </div>
      )}
      {trace.data?.map(([near, cable, far], i) => {
        const color = cable?.color ? `#${String(cable.color)}` : undefined;
        return (
          <div key={i} className="nb-trace">
            <TraceEnd ends={near} />
            <div className="cable" style={color ? { borderLeftColor: color } : undefined}>
              {cable ? (
                <div>
                  <Link to={`/dcim/cables?_sel=${cable.id}`}>
                    {fieldLabel('cable')} {cable.display}
                  </Link>{' '}
                  <StatusChip value={cable.status as never} />
                  <div className="nb-muted">
                    {[(cable.type as { label?: string } | null)?.label, cable.length != null ? `${String(cable.length)} ${(cable.length_unit as { value?: string } | null)?.value ?? ''}` : null].filter(Boolean).join(' · ')}
                  </div>
                </div>
              ) : (
                t('notConnected')
              )}
            </div>
            {far.length > 0 && <TraceEnd ends={far} />}
          </div>
        );
      })}
    </Layout>
  );
}
