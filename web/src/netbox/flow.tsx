/**
 * Traffic from Current on DCIM/IPAM pages (docs/integrations.md, "Current"). Everything here renders
 * nothing when no Current integration is active or Current fails, like the Beacon chips.
 */
import type { FlowPrefixAddressesResponse, FlowTraffic } from '@shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { request, toQuery, type NbObject, type Ref } from './api';
import { Card, Chip, UtilBar } from './components';
import { formatBps, formatBytes, formatTimeRange, sparkPoints, utilPct, utilTone } from './format';
import { useAsync, useFlowTraffic } from './hooks';
import { currentLang, fieldLabel, t } from './i18n';

const bps = (v: number | null | undefined) => formatBps(v, currentLang());
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(currentLang()) : '—');
const worstUtil = (tr: FlowTraffic) => {
  const values = [utilPct(tr.utilization_in), utilPct(tr.utilization_out)].filter((v): v is number => v != null);
  return values.length ? Math.max(...values) : null;
};

/** Compact in/out rates with a utilisation bar: list cells and interface rows. */
export function TrafficCell({ traffic }: { traffic: FlowTraffic | undefined }) {
  if (!traffic) return <span className="nb-muted">—</span>;
  const util = worstUtil(traffic);
  return (
    <span className="nb-traffic" title={`${t('inbound')}: ${bps(traffic.in_bps)} · ${t('outbound')}: ${bps(traffic.out_bps)}`}>
      <span className="nb-traffic-rates">
        <span className="in">↓ {bps(traffic.in_bps)}</span>
        <span className="out">↑ {bps(traffic.out_bps)}</span>
      </span>
      {util != null && (
        <span className="bar" aria-label={`${t('utilization')}: ${util}%`}>
          <span className={`fill ${utilTone(Math.min(util, 100))}`} style={{ width: `${Math.min(util, 100)}%` }} />
        </span>
      )}
    </span>
  );
}

/** In/out chip next to an object's title; tone follows the worst utilisation. */
export function TrafficChip({ traffic }: { traffic: FlowTraffic | undefined }) {
  if (!traffic) return null;
  const util = worstUtil(traffic);
  const tone = util == null ? 'info' : utilTone(util);
  return (
    <Chip tone={tone} title={util != null ? `${t('utilization')}: ${util}%` : t('traffic')}>
      ↓ {bps(traffic.in_bps)} · ↑ {bps(traffic.out_bps)}
    </Chip>
  );
}

/** In (accent) and out (purple) series of the last window. */
export function Sparkline({ data, width = 320, height = 56 }: { data: FlowTraffic['sparkline']; width?: number; height?: number }) {
  if (!data || !data.in?.length) return null;
  // The drawing scale is at least 1 b/s; the peak shown is the real one.
  const peak = Math.max(0, ...data.in.map(Number), ...(data.out ?? []).map(Number));
  const max = Math.max(1, peak);
  const first = data.t?.[0];
  const last = data.t?.[data.t.length - 1];
  // t are bucket starts: the window ends one bucket after the last start.
  const step = data.t && data.t.length > 1 ? Date.parse(data.t[1]) - Date.parse(data.t[0]) : 0;
  const end = last ? new Date(Date.parse(last) + (Number.isFinite(step) ? step : 0)) : null;
  return (
    <figure className="nb-spark" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${t('traffic')}: ${t('inbound')} / ${t('outbound')}`}>
        <polyline className="in" points={sparkPoints(data.in, max, width, height)} vectorEffect="non-scaling-stroke" />
        {data.out?.length ? <polyline className="out" points={sparkPoints(data.out, max, width, height)} vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      <figcaption>
        <span className="nb-spark-key in">{t('inbound')}</span>
        <span className="nb-spark-key out">{t('outbound')}</span>
        <span className="nb-spacer" />
        <span className="nb-muted">
          {peak > 0 ? `${t('peak')}: ${bps(peak)}` : t('noTrafficWindow')}
          {first && end ? ` · ${formatTimeRange(new Date(first), end, currentLang())}` : ''}
        </span>
      </figcaption>
    </figure>
  );
}

function OpenInFlow({ traffic }: { traffic: FlowTraffic }) {
  if (!traffic.flow_url || !/^https?:\/\//i.test(traffic.flow_url)) return null;
  return (
    <a className="nb-btn" href={traffic.flow_url} target="_blank" rel="noreferrer noopener">
      {t('openInFlow')} ↗
    </a>
  );
}

/** Commit of a circuit (or an interface on one): monthly 95th percentile against the commit rate. */
function CommitRows({ traffic }: { traffic: FlowTraffic }) {
  if (traffic.p95_month_bps == null && traffic.commit_bps == null) return null;
  const pct = traffic.commit_bps ? Math.round(((traffic.p95_month_bps ?? 0) / traffic.commit_bps) * 100) : null;
  return (
    <div className="nb-flow-commit">
      <div>
        <span className="nb-muted">{t('p95Month')}</span> <b>{bps(traffic.p95_month_bps)}</b>
        <span className="nb-muted"> / {t('commit')}</span> <b>{bps(traffic.commit_bps)}</b>
      </div>
      {pct != null && <UtilBar value={pct} />}
      {traffic.over_commit != null && <Chip tone={traffic.over_commit ? 'critical' : 'ok'}>{traffic.over_commit ? t('overCommit') : t('withinCommit')}</Chip>}
    </div>
  );
}

/** Card with rates, utilisation, the 24 h sparkline and a link to Current, for device / interface / circuit pages. */
export function FlowTrafficCard({ objectType, id, commit = false }: { objectType: 'dcim.device' | 'dcim.interface' | 'circuits.circuit'; id: number; commit?: boolean }) {
  const traffic = useFlowTraffic(objectType, [id]);
  if (!traffic) return null;
  const tr = traffic.get(id);
  return (
    <Card title={t('traffic24h')} actions={tr && <OpenInFlow traffic={tr} />}>
      {!tr ? (
        <div className="nb-muted">{t('noTraffic')}</div>
      ) : (
        <div className="nb-flow">
          <div className="nb-flow-rates">
            <div>
              <span className="nb-muted">{t('inbound')}</span>
              <b>{bps(tr.in_bps)}</b>
              {utilPct(tr.utilization_in) != null && <UtilBar value={Math.min(100, utilPct(tr.utilization_in)!)} />}
            </div>
            <div>
              <span className="nb-muted">{t('outbound')}</span>
              <b>{bps(tr.out_bps)}</b>
              {utilPct(tr.utilization_out) != null && <UtilBar value={Math.min(100, utilPct(tr.utilization_out)!)} />}
            </div>
            {tr.speed_bps != null && (
              <div>
                <span className="nb-muted">{t('linkSpeed')}</span>
                <b>{bps(tr.speed_bps)}</b>
              </div>
            )}
          </div>
          <Sparkline data={tr.sparkline} />
          {commit && <CommitRows traffic={tr} />}
          <div className="nb-muted">
            {t('lastSeen')}: {when(tr.last_seen)}
          </div>
        </div>
      )}
    </Card>
  );
}

/** Chip for the title bar of a device page. */
export function FlowTitleChip({ objectType, id }: { objectType: 'dcim.device' | 'dcim.interface' | 'circuits.circuit'; id: number }) {
  const traffic = useFlowTraffic(objectType, [id]);
  const tr = traffic?.get(id);
  if (!tr) return null;
  return (
    <span title={t('traffic')}>
      <TrafficChip traffic={tr} />
    </span>
  );
}

/** Circuit page: over-commit chip in the title bar. */
export function CommitChip({ id }: { id: number }) {
  const traffic = useFlowTraffic('circuits.circuit', [id]);
  const tr = traffic?.get(id);
  if (!tr || tr.over_commit == null) return null;
  return <Chip tone={tr.over_commit ? 'critical' : 'ok'}>{tr.over_commit ? t('overCommit') : t('withinCommit')}</Chip>;
}

/**
 * Prefix page: addresses Current saw inside the prefix. Rows that are not in IPAM get a "Create IP address" action that
 * opens the usual IPAM create form with the address filled in.
 */
export function PrefixFlowAddresses({
  prefix,
  canWrite,
  onCreate,
  version,
}: {
  prefix: NbObject;
  canWrite: boolean;
  onCreate: (presets: Record<string, unknown>) => void;
  /** Changes when the page reloads, so in-IPAM flags are re-read after an address was created. */
  version: unknown;
}) {
  const cidr = String(prefix.prefix);
  const vrf = prefix.vrf as Ref | null;
  const { data } = useAsync(async () => {
    try {
      return await request<FlowPrefixAddressesResponse>('GET', `/api/v1/integrations/flow/prefix-addresses${toQuery({ prefix: cidr, vrf: vrf?.display })}`);
    } catch {
      return null;
    }
  }, [cidr, vrf?.id, version]);
  const [showAll, setShowAll] = useState(false);
  if (!data) return null;
  const plen = cidr.split('/')[1];
  const rows = showAll ? data.results : data.results.slice(0, 50);
  const missing = data.results.filter((r) => !r.in_ipam).length;
  return (
    <div style={{ marginTop: 12 }}>
      <Card
        title={`${t('activeAddresses')} (${data.results.length})`}
        actions={missing > 0 && <Chip tone="warning">{t('notInIpamCount', { n: missing })}</Chip>}
      >
        {!data.results.length ? (
          <div className="nb-muted">{t('noTraffic')}</div>
        ) : (
          <div className="nb-table-wrap">
            <table className="nb-table">
              <thead>
                <tr>
                  <th>{fieldLabel('address')}</th>
                  <th>{t('bytes')}</th>
                  <th>{t('flows')}</th>
                  <th>{t('lastSeen')}</th>
                  <th>{t('inIpam')}</th>
                  {canWrite && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.address}>
                    <td>
                      <code>{r.address}</code>
                    </td>
                    <td>{formatBytes(r.bytes, currentLang())}</td>
                    <td>{r.flows.toLocaleString(currentLang())}</td>
                    <td>{when(r.last_seen)}</td>
                    <td>
                      {r.in_ipam ? (
                        r.ip_address_id ? (
                          <Link to={`/ipam/ip-addresses/${r.ip_address_id}`}>
                            <Chip tone="ok">{t('yes')}</Chip>
                          </Link>
                        ) : (
                          <Chip tone="ok">{t('yes')}</Chip>
                        )
                      ) : (
                        <Chip tone="warning">{t('notInIpam')}</Chip>
                      )}
                    </td>
                    {canWrite && (
                      <td>
                        {!r.in_ipam && (
                          <button
                            className="nb-btn"
                            onClick={() =>
                              onCreate({
                                address: `${r.address}/${plen}`,
                                status: 'active',
                                description: 'Discovered by Current',
                                ...(vrf ? { vrf: vrf.id } : {}),
                              })
                            }
                          >
                            + {t('createIp')}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.results.length > rows.length && (
          <button className="nb-btn" style={{ marginTop: 8 }} onClick={() => setShowAll(true)}>
            {t('showAll', { n: data.results.length })}
          </button>
        )}
      </Card>
    </div>
  );
}
