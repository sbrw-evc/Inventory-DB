import type { FieldType, FilterOp, RollupFunction } from './fieldTypes.js';

export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';
export const ROLE_RANK: Record<Role, number> = { viewer: 1, commenter: 2, editor: 3, owner: 4 };

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface Base {
  id: string;
  title: string;
  description?: string | null;
  color?: string | null;
  order: number;
  createdAt: string;
  /** Role of the requesting user in this base. */
  role?: Role;
}

export interface BaseMember {
  userId: string;
  email: string;
  name: string;
  role: Role;
}

export interface SelectOption {
  /** Stable id assigned by the server; send it back on update so renames also rename the data. */
  id?: string;
  title: string;
  color: string;
}

/** Type-specific settings stored on a column as JSON. */
export interface ColumnOptions {
  /** SingleSelect / MultiSelect */
  choices?: SelectOption[];
  /** Number-ish */
  precision?: number;
  currencyCode?: string; // e.g. 'USD'
  /** Rating */
  max?: number;
  icon?: string;
  /** Date / DateTime */
  dateFormat?: string;
  /** Links: target table and relation type */
  relatedTableId?: string;
  relation?: 'mm' | 'hm' | 'bt';
  /** The paired Links column on the related table (created automatically). */
  symmetricColumnId?: string;
  /** Lookup / Rollup: which Links column on this table, and which column on the related table */
  linkColumnId?: string;
  targetColumnId?: string;
  /** Rollup */
  rollupFunction?: RollupFunction;
  /** Formula source as typed by the user, using {Field Title} references */
  formula?: string;
  /** Checkbox */
  checkedIcon?: string;
  /**
   * Field-level permissions (NocoDB-style). Owners always have full access. A role in `hiddenFor` can't read
   * the field at all (it is left out of records, table meta, exports and shared views); a role in `readOnlyFor`
   * sees it but can't write it. Only owners may change this.
   */
  permissions?: FieldPermissions;
}

export interface FieldPermissions {
  hiddenFor?: Role[];
  readOnlyFor?: Role[];
}

export interface Column {
  id: string;
  tableId: string;
  title: string;
  type: FieldType;
  /** Is this the record's display value (shown in links, kanban cards, etc.) */
  primary: boolean;
  required: boolean;
  defaultValue?: unknown;
  description?: string | null;
  options: ColumnOptions;
  order: number;
  /** Physical column name (stored types) — server only detail but harmless to expose */
  system?: boolean;
}

/** Body of "create column" (and, partially, of "update column"). */
export interface ColumnInput {
  title: string;
  type: FieldType;
  options?: ColumnOptions;
  required?: boolean;
  defaultValue?: unknown;
  description?: string | null;
  primary?: boolean;
}

export interface Table {
  id: string;
  baseId: string;
  title: string;
  description?: string | null;
  order: number;
  columns: Column[];
  views?: View[];
}

export type ViewType = 'grid' | 'form' | 'gallery' | 'kanban' | 'calendar' | 'timeline' | 'map';
export const VIEW_TYPES: readonly ViewType[] = ['grid', 'form', 'gallery', 'kanban', 'calendar', 'timeline', 'map'];

export interface ViewColumn {
  columnId: string;
  show: boolean;
  order: number;
  width?: number;
  /** Form view: label override, help text, required override */
  label?: string;
  help?: string;
  required?: boolean;
}

export interface FilterCondition {
  id?: string;
  columnId: string;
  op: FilterOp;
  value?: unknown;
}

export interface FilterGroup {
  id?: string;
  logic: 'and' | 'or';
  children: Array<FilterCondition | FilterGroup>;
}

export const isFilterGroup = (f: FilterCondition | FilterGroup): f is FilterGroup =>
  (f as FilterGroup).children !== undefined;

export interface Sort {
  columnId: string;
  direction: 'asc' | 'desc';
}

export interface ViewMeta {
  /** kanban: SingleSelect column used for stacks; timeline: SingleSelect or Links column used for swimlanes */
  groupColumnId?: string;
  /** gallery/kanban: Attachment column used as cover */
  coverColumnId?: string;
  /** calendar / timeline: Date/DateTime start column and optional end column (multi-day spans) */
  dateColumnId?: string;
  endDateColumnId?: string;
  /** timeline: zoom level */
  timelineScale?: 'day' | 'week' | 'month';
  /** map: GeoData column used to place markers */
  geoColumnId?: string;
  /** grid: group by columns (max 3) */
  groupBy?: Sort[];
  rowHeight?: 'short' | 'medium' | 'tall';
  /** form view */
  formHeading?: string;
  formSubheading?: string;
  formSubmitMessage?: string;
  formRedirectUrl?: string;
  /** stack order for kanban */
  stackOrder?: string[];
}

export interface View {
  id: string;
  tableId: string;
  title: string;
  type: ViewType;
  order: number;
  locked: boolean;
  filter: FilterGroup | null;
  sorts: Sort[];
  columns: ViewColumn[];
  meta: ViewMeta;
  /** Public sharing */
  shareUuid?: string | null;
  sharePasswordSet?: boolean;
}

export interface Attachment {
  url: string;
  title: string;
  mimetype?: string;
  size?: number;
}

/** A record as returned by the API: keys are column ids, plus `id`. */
export type RecordData = { id: number } & Record<string, unknown>;

export interface ListQuery {
  viewId?: string;
  offset?: number;
  limit?: number;
  /** Extra filter ANDed with the view's filter */
  filter?: FilterGroup;
  /** Overrides the view's sorts when given */
  sorts?: Sort[];
  search?: string;
  /** Restrict search to one column; default searches all text-like fields */
  searchColumnId?: string;
  /** Return only these column ids */
  fields?: string[];
}

export interface ListResult {
  list: RecordData[];
  pageInfo: { totalRows: number; offset: number; limit: number; isLastPage: boolean };
}

export interface GroupResult {
  /** Grouped by the column's raw value */
  value: unknown;
  count: number;
}

export interface Comment {
  id: string;
  tableId: string;
  recordId: number;
  userId: string;
  userName: string;
  body: string;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  baseId: string;
  tableId?: string | null;
  recordId?: number | null;
  userId?: string | null;
  userName?: string | null;
  action: 'insert' | 'update' | 'delete' | 'link' | 'unlink' | 'meta' | 'import';
  /** For updates: { columnId: { from, to } } */
  details: unknown;
  createdAt: string;
}

export type WebhookEvent = 'after.insert' | 'after.update' | 'after.delete';

export interface Webhook {
  id: string;
  tableId: string;
  title: string;
  event: WebhookEvent;
  url: string;
  method: 'POST' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  active: boolean;
  /** Optional condition: only fire when the record matches */
  condition?: FilterGroup | null;
}

export interface WebhookLog {
  id: string;
  hookId: string;
  event: WebhookEvent;
  status: number | null;
  error?: string | null;
  payload: unknown;
  response?: string | null;
  createdAt: string;
}

export interface ApiToken {
  id: string;
  description: string;
  /** Only returned once, on creation */
  token?: string;
  createdAt: string;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  kind: 'nocodb-migration' | 'import';
  status: JobStatus;
  progress: number; // 0..1
  message: string;
  log: string[];
  result?: unknown;
  createdAt: string;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
