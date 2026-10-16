/**
 * Integrations with other systems: Beacon (github.com/sbrw-evc/beacon) and Current
 * (traffic analytics; contract in the Network repo's docs/integrations.md §2).
 */
export type IntegrationKind = 'umbrella' | 'flow';

/** Result of the last change notification sent to Current. */
export interface FlowDelivery {
  at: string;
  ok: boolean;
  /** HTTP status Current answered with (absent on network errors / timeouts). */
  httpStatus?: number | null;
  error?: string | null;
  /** Events in the batch and attempts it took. */
  events: number;
  attempts: number;
}

export interface Integration {
  id: string;
  kind: IntegrationKind;
  title: string;
  active: boolean;
  /** Beacon web UI, used to build links back to it (optional). */
  umbrellaUrl?: string | null;
  /** Public URL of this Ledger, used for record links in the CMDB feed. Defaults to the request host. */
  inventoryUrl?: string | null;
  /** When Beacon last read the whole CMDB feed, and how many CIs it had. */
  lastFeedAt?: string | null;
  lastFeedCount?: number | null;
  /** When Beacon last delivered a correctly signed alert batch. */
  lastAlertAt?: string | null;
  /** Current base URL (kind `flow`). */
  flowUrl?: string | null;
  /** Whether a Current API token is stored (the token itself never leaves the server). */
  flowTokenSet?: boolean;
  /** Last change notification sent to Current (kind `flow`). */
  lastDelivery?: FlowDelivery | null;
  createdBy: string;
  createdAt: string;
}

export interface IntegrationInput {
  kind: IntegrationKind;
  title: string;
  active?: boolean;
  umbrellaUrl?: string | null;
  inventoryUrl?: string | null;
  /** Kind `flow`: Current base URL and API token (stored in the secret store, write-only). */
  flowUrl?: string | null;
  flowToken?: string;
}

/** Object types Current reports traffic for. */
export type FlowObjectType = 'dcim.device' | 'dcim.interface' | 'circuits.circuit';

/** Traffic of one object as Current reports it (`GET …/inventory-db/status`). */
export interface FlowTraffic {
  in_bps: number | null;
  out_bps: number | null;
  speed_bps?: number | null;
  utilization_in?: number | null;
  utilization_out?: number | null;
  p95_month_bps?: number | null;
  commit_bps?: number | null;
  over_commit?: boolean | null;
  sparkline?: { t: string[]; in: number[]; out: number[] } | null;
  flow_url?: string | null;
  last_seen?: string | null;
}

export interface FlowStatusResponse {
  window: string;
  results: Record<string, FlowTraffic>;
}

export interface FlowPrefixAddress {
  address: string;
  bytes: number;
  flows: number;
  last_seen: string | null;
  /** In Ledger's IPAM (checked locally, so it is current even when Current's snapshot lags). */
  in_ipam: boolean;
  /** Id of the matching IPAM address, when there is one. */
  ip_address_id?: number | null;
}

export interface FlowPrefixAddressesResponse {
  prefix: string;
  results: FlowPrefixAddress[];
}

/** Beacon severity levels (PagerDuty's four). */
export type MonitoringSeverity = 'critical' | 'error' | 'warning' | 'info';
/** Beacon alert lifecycle. */
export type MonitoringAlertStatus = 'open' | 'acknowledged' | 'resolved' | 'closed';
/** Rolled-up status of an inventory object: worst severity of its active alerts, or `ok`. */
export type MonitoringState = MonitoringSeverity | 'ok';

/** Object types the CMDB feed exports and alerts can attach to. */
export type InventoryObjectType = 'dcim.site' | 'dcim.rack' | 'dcim.device';

/** Configuration item in the shape Beacon's CMDB Discovery builds its map from. */
export interface UmbrellaCi {
  /** Stable reference, e.g. `inventory-db:dcim.device:12`. Beacon stores it in the CI's source_refs. */
  source_ref: string;
  type: 'site' | 'rack' | 'device';
  name: string;
  identities: { hostname?: string; fqdn?: string[]; ip?: string[]; serial?: string; asset_tag?: string };
  logical_group: string | null;
  /** NetBox-style lifecycle status (active, planned, staged, failed, offline, decommissioning, ...). */
  status: string;
  /** False for objects that should not page anyone (planned, offline, decommissioning, inventory). */
  monitored: boolean;
  attributes: Record<string, unknown>;
  relations: { type: 'located_in' | 'connected_to'; direction: 'out'; target_ref: string; via?: string }[];
  url: string;
  last_updated: string | null;
}

export interface UmbrellaCiFeed {
  source: 'inventory-db';
  integration_id: string;
  generated_at: string;
  count: number;
  offset: number;
  next_offset: number | null;
  items: UmbrellaCi[];
}

/** Body Beacon POSTs to `/integrations/:id/umbrella/alerts` (signed, see docs/integrations.md). */
export interface UmbrellaAlertEvent {
  alert_id: string;
  status: MonitoringAlertStatus;
  severity: MonitoringSeverity;
  title: string;
  signal?: string;
  ci: { source_refs?: string[]; name?: string; identities?: { hostname?: string; fqdn?: string; ip?: string | string[] } };
  links?: { incident?: string; grafana?: string };
  /** When the alert last changed in Beacon; older updates than the stored one are ignored. */
  updated_at?: string;
}

export interface MonitoringAlert {
  integrationId: string;
  alertId: string;
  objectType: InventoryObjectType;
  objectId: number;
  status: MonitoringAlertStatus;
  severity: MonitoringSeverity;
  title: string;
  signal: string | null;
  incidentUrl: string | null;
  grafanaUrl: string | null;
  firstSeen: string;
  updatedAt: string;
}

export interface MonitoringStatus {
  objectType: InventoryObjectType;
  objectId: number;
  state: MonitoringState;
  /** Active (open or acknowledged) alerts, worst first. */
  alerts: MonitoringAlert[];
  /** The same state in the shape the DCIM status chips read (see docs/netbox.md). */
  object_id: number;
  status: MonitoringState;
  open_alerts: number;
  incident_url: string | null;
}
