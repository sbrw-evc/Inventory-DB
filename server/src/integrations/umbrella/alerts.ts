import type {
  InventoryObjectType,
  MonitoringAlert,
  MonitoringSeverity,
  MonitoringState,
  MonitoringStatus,
  UmbrellaAlertEvent,
  UmbrellaCi,
} from '../../../../shared/src/index.js';
import { getDb, now } from '../../db/index.js';
import { parseSourceRef } from './ci.js';

const SEVERITY_RANK: Record<MonitoringSeverity, number> = { info: 1, warning: 2, error: 3, critical: 4 };
const ACTIVE = ['open', 'acknowledged'];

export interface Target {
  type: InventoryObjectType;
  id: number;
}

/** Lookup tables from identities (lower-cased) to the inventory objects carrying them. */
export interface IdentityIndex {
  byName: Map<string, Target[]>;
  byIp: Map<string, Target[]>;
}

export function buildIdentityIndex(cis: UmbrellaCi[]): IdentityIndex {
  const index: IdentityIndex = { byName: new Map(), byIp: new Map() };
  const add = (map: Map<string, Target[]>, key: string | undefined, t: Target) => {
    if (!key) return;
    const k = key.toLowerCase();
    const list = map.get(k) ?? [];
    if (!list.some((x) => x.type === t.type && x.id === t.id)) list.push(t);
    map.set(k, list);
  };
  for (const ci of cis) {
    const t = parseSourceRef(ci.source_ref);
    if (!t || t.type !== 'dcim.device') continue; // alerts attach to devices; sites and racks only by source_ref
    add(index.byName, ci.name, t);
    add(index.byName, ci.identities.hostname, t);
    for (const f of ci.identities.fqdn ?? []) {
      add(index.byName, f, t);
      add(index.byName, f.split('.')[0], t);
    }
    for (const ip of ci.identities.ip ?? []) add(index.byIp, ip, t);
  }
  return index;
}

/**
 * Finds the inventory objects an Umbrella alert is about. Umbrella sends back the source_refs it got
 * from the CMDB feed, so that is tried first; names, FQDNs and IPs cover CIs Umbrella discovered elsewhere.
 */
export function matchTargets(ci: UmbrellaAlertEvent['ci'], index: () => IdentityIndex): Target[] {
  const fromRefs = (ci.source_refs ?? []).map(parseSourceRef).filter((t): t is Target => t !== null);
  if (fromRefs.length) return fromRefs;
  const idx = index();
  const names = [ci.identities?.hostname, ci.identities?.fqdn, ci.identities?.fqdn?.split('.')[0], ci.name];
  for (const n of names) {
    const hit = n ? idx.byName.get(n.toLowerCase()) : undefined;
    if (hit?.length) return hit;
  }
  const ips = ci.identities?.ip == null ? [] : Array.isArray(ci.identities.ip) ? ci.identities.ip : [ci.identities.ip];
  for (const ip of ips) {
    const hit = idx.byIp.get(ip.split('/')[0].toLowerCase());
    if (hit?.length) return hit;
  }
  return [];
}

/** Upserts the alert for every matched object. Updates older than the stored one are ignored. */
export function recordAlert(integrationId: string, event: UmbrellaAlertEvent, targets: Target[]) {
  const db = getDb();
  const ts = event.updated_at ?? now();
  if (!targets.length) {
    db.prepare(
      `INSERT INTO nc_monitoring_unmatched (integration_id, alert_id, title, ci, received_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (integration_id, alert_id) DO UPDATE SET title = excluded.title, ci = excluded.ci, received_at = excluded.received_at`,
    ).run(integrationId, event.alert_id, event.title, JSON.stringify(event.ci), now());
    return;
  }
  const upsert = db.prepare(
    `INSERT INTO nc_monitoring_alerts
       (integration_id, alert_id, object_type, object_id, status, severity, title, signal, incident_url, grafana_url, first_seen, updated_at)
     VALUES (@integrationId, @alertId, @type, @id, @status, @severity, @title, @signal, @incident, @grafana, @ts, @ts)
     ON CONFLICT (integration_id, alert_id, object_type, object_id) DO UPDATE SET
       status = excluded.status, severity = excluded.severity, title = excluded.title, signal = excluded.signal,
       incident_url = COALESCE(excluded.incident_url, incident_url), grafana_url = COALESCE(excluded.grafana_url, grafana_url),
       updated_at = excluded.updated_at
     WHERE excluded.updated_at >= nc_monitoring_alerts.updated_at`,
  );
  db.transaction(() => {
    db.prepare('DELETE FROM nc_monitoring_unmatched WHERE integration_id = ? AND alert_id = ?').run(integrationId, event.alert_id);
    for (const t of targets)
      upsert.run({
        integrationId,
        alertId: event.alert_id,
        type: t.type,
        id: t.id,
        status: event.status,
        severity: event.severity,
        title: event.title,
        signal: event.signal ?? null,
        incident: event.links?.incident ?? null,
        grafana: event.links?.grafana ?? null,
        ts,
      });
    // Closed alerts are history; keep the table small.
    db.prepare(
      "DELETE FROM nc_monitoring_alerts WHERE integration_id = ? AND status IN ('resolved','closed') AND updated_at < ?",
    ).run(integrationId, new Date(Date.now() - 30 * 86400_000).toISOString());
  })();
}

interface AlertRow {
  integration_id: string;
  alert_id: string;
  object_type: InventoryObjectType;
  object_id: number;
  status: MonitoringAlert['status'];
  severity: MonitoringSeverity;
  title: string;
  signal: string | null;
  incident_url: string | null;
  grafana_url: string | null;
  first_seen: string;
  updated_at: string;
}

const toAlert = (r: AlertRow): MonitoringAlert => ({
  integrationId: r.integration_id,
  alertId: r.alert_id,
  objectType: r.object_type,
  objectId: r.object_id,
  status: r.status,
  severity: r.severity,
  title: r.title,
  signal: r.signal,
  incidentUrl: r.incident_url,
  grafanaUrl: r.grafana_url,
  firstSeen: r.first_seen,
  updatedAt: r.updated_at,
});

const worstFirst = (a: MonitoringAlert, b: MonitoringAlert) =>
  SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.updatedAt.localeCompare(a.updatedAt);

/**
 * Rolled-up monitoring state per object from all active integrations. With `ids`, every requested object
 * is returned (`ok` when it has no active alerts); without, only objects that have active alerts.
 */
export function monitoringStatus(type: InventoryObjectType, ids?: number[]): MonitoringStatus[] {
  const params: unknown[] = [type, ...ACTIVE];
  let sql = `SELECT a.* FROM nc_monitoring_alerts a JOIN nc_integrations i ON i.id = a.integration_id
    WHERE i.active = 1 AND a.object_type = ? AND a.status IN (?, ?)`;
  if (ids) {
    if (!ids.length) return [];
    sql += ` AND a.object_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }
  const rows = getDb().prepare(sql).all(...params) as AlertRow[];
  const byObject = new Map<number, MonitoringAlert[]>();
  for (const id of ids ?? []) byObject.set(id, []);
  for (const r of rows) byObject.set(r.object_id, [...(byObject.get(r.object_id) ?? []), toAlert(r)]);
  return [...byObject].map(([objectId, alerts]) => {
    alerts.sort(worstFirst);
    const state: MonitoringState = alerts[0]?.severity ?? 'ok';
    return { objectType: type, objectId, state, alerts };
  });
}

/** Recent alerts of one object, active and resolved, newest first. */
export function alertHistory(type: InventoryObjectType, id: number, limit = 50): MonitoringAlert[] {
  const rows = getDb()
    .prepare(
      `SELECT a.* FROM nc_monitoring_alerts a JOIN nc_integrations i ON i.id = a.integration_id
       WHERE i.active = 1 AND a.object_type = ? AND a.object_id = ? ORDER BY a.updated_at DESC LIMIT ?`,
    )
    .all(type, id, limit) as AlertRow[];
  return rows.map(toAlert);
}

export function listUnmatched(integrationId: string) {
  return (
    getDb()
      .prepare('SELECT alert_id, title, ci, received_at FROM nc_monitoring_unmatched WHERE integration_id = ? ORDER BY received_at DESC LIMIT 200')
      .all(integrationId) as { alert_id: string; title: string; ci: string; received_at: string }[]
  ).map((r) => ({ alertId: r.alert_id, title: r.title, ci: JSON.parse(r.ci), receivedAt: r.received_at }));
}
