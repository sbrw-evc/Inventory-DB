/** Integrations with other systems. Today: Umbrella monitoring (github.com/sbrw-evc/Umbrella-Monitoring). */
export type IntegrationKind = 'umbrella';

export interface Integration {
  id: string;
  kind: IntegrationKind;
  title: string;
  active: boolean;
  /** Umbrella web UI, used to build links back to it (optional). */
  umbrellaUrl?: string | null;
  /** Public URL of this Inventory DB, used for record links in the CMDB feed. Defaults to the request host. */
  inventoryUrl?: string | null;
  createdBy: string;
  createdAt: string;
}

export interface IntegrationInput {
  kind: IntegrationKind;
  title: string;
  active?: boolean;
  umbrellaUrl?: string | null;
  inventoryUrl?: string | null;
}

/** Umbrella severity levels (PagerDuty's four). */
export type MonitoringSeverity = 'critical' | 'error' | 'warning' | 'info';
/** Umbrella alert lifecycle. */
export type MonitoringAlertStatus = 'open' | 'acknowledged' | 'resolved' | 'closed';
/** Rolled-up status of an inventory object: worst severity of its active alerts, or `ok`. */
export type MonitoringState = MonitoringSeverity | 'ok';

/** Object types the CMDB feed exports and alerts can attach to. */
export type InventoryObjectType = 'dcim.site' | 'dcim.rack' | 'dcim.device';

/** Configuration item in the shape Umbrella's CMDB Discovery builds its map from. */
export interface UmbrellaCi {
  /** Stable reference, e.g. `inventory-db:dcim.device:12`. Umbrella stores it in the CI's source_refs. */
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

/** Body Umbrella POSTs to `/integrations/:id/umbrella/alerts` (signed, see docs/integrations.md). */
export interface UmbrellaAlertEvent {
  alert_id: string;
  status: MonitoringAlertStatus;
  severity: MonitoringSeverity;
  title: string;
  signal?: string;
  ci: { source_refs?: string[]; name?: string; identities?: { hostname?: string; fqdn?: string; ip?: string | string[] } };
  links?: { incident?: string; grafana?: string };
  /** When the alert last changed in Umbrella; older updates than the stored one are ignored. */
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
