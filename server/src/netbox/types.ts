import type { User } from '../../../shared/src/index.js';
import type { DB } from '../db/index.js';

/** A database row of an `nb_*` table, keyed by column name (foreign keys end in `_id`). */
export type Row = Record<string, any>;
/** A serialized API object. */
export type Obj = Record<string, unknown>;
/** Field name → messages, NetBox style. */
export type Errors = Record<string, string[]>;

export type FieldKind =
  | 'string'
  | 'text'
  | 'slug'
  | 'int'
  | 'float'
  | 'bool'
  | 'choice'
  | 'fk'
  | 'm2m'
  | 'color'
  | 'date'
  | 'json'
  | 'mac'
  | 'cidr'
  | 'ipaddr';

export type Choice = readonly [value: string, label: string];

export interface FieldDef {
  name: string;
  kind: FieldKind;
  required?: boolean;
  default?: unknown;
  choices?: readonly Choice[];
  /** Object type referenced by fk / m2m fields, e.g. `dcim.site`. */
  ref?: string;
  /** What happens to this object when the referenced one is deleted. Default `protect`. */
  onDelete?: 'protect' | 'cascade' | 'setnull';
  maxLength?: number;
  min?: number;
  max?: number;
  /** Maintained by the server; ignored on input. */
  readOnly?: boolean;
  /** Included in `?q=` text search. */
  search?: boolean;
  /** Integer choice list (e.g. rack width). */
  intChoices?: readonly number[];
}

export interface SqlFrag {
  sql: string;
  params: unknown[];
}

export interface PendingEvent {
  event: 'object.created' | 'object.updated' | 'object.deleted';
  objectType: string;
  id: number;
  data: Obj;
}

/** Request-scoped context handed to model hooks (avoids import cycles between models and the engine). */
export interface Ctx {
  db: DB;
  user: User | null;
  requestId: string;
  get(type: string, id: number | null | undefined): Row | null;
  ref(type: string, id: number | null | undefined): Obj | null;
  serialize(type: string, row: Row): Obj;
  create(type: string, body: Record<string, unknown>): Row;
  update(type: string, id: number, body: Record<string, unknown>): Row;
  remove(type: string, id: number): void;
  /** Clears cached rows after direct SQL writes. */
  invalidate(): void;
  knownType(type: string): boolean;
  events: PendingEvent[];
}

export interface WriteInfo {
  /** Existing row on update, null on create. */
  existing: Row | null;
  /** Non-column inputs the model declared in `writeExtras`. */
  extras: Record<string, unknown>;
  /** Fields present in the request body. */
  provided: Set<string>;
  /** m2m values (field name → ids) after merge. */
  m2m: Record<string, number[]>;
}

export interface ModelDef {
  type: string;
  app: 'dcim' | 'ipam' | 'tenancy' | 'extras';
  path: string;
  table: string;
  verbose: string;
  verbosePlural: string;
  fields: FieldDef[];
  /** Derived/system columns: name → SQL type. */
  extraColumns?: Record<string, string>;
  indexes?: string[];
  /** Field-name tuples that must be unique (NULLs compare equal, text case-insensitively). */
  unique?: string[][];
  /** Fields included in nested (brief) representations besides id/url/display. */
  brief: string[];
  display(row: Row, ctx: Ctx): string;
  ordering: string[];
  /** Custom SQL for ordering keys (key → comma separated expressions, written for ascending). */
  orderExpr?: Record<string, string>;
  taggable?: boolean;
  customFields?: boolean;
  /** Read-only model (no create/update/delete endpoints). */
  readOnlyModel?: boolean;
  writeExtras?: string[];
  /** Normalise input and compute derived columns. */
  derive?(rec: Row, errors: Errors, ctx: Ctx, info: WriteInfo): void;
  validate?(rec: Row, errors: Errors, ctx: Ctx, info: WriteInfo): void;
  afterWrite?(row: Row, ctx: Ctx, info: WriteInfo): void;
  beforeDelete?(row: Row, ctx: Ctx): void;
  serializeExtra?(row: Row, ctx: Ctx): Obj;
  /** Extra list filters: query key → SQL fragment against alias `t`. */
  filters?: Record<string, (values: string[], ctx: Ctx) => SqlFrag>;
  /** Extra `?q=` matching (e.g. "which prefixes contain this IP"). */
  searchExtra?(q: string): SqlFrag | null;
}

/** Column name of a field. */
export const colOf = (f: FieldDef) => (f.kind === 'fk' ? `${f.name}_id` : f.name);

const titleCase = (v: string) => v.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Builds a choice list; strings get a title-cased label. */
export const choices = (...items: (string | Choice)[]): Choice[] =>
  items.map((i) => (typeof i === 'string' ? ([i, titleCase(i)] as const) : i));

export const choiceLabel = (f: FieldDef, value: string) => f.choices?.find((c) => c[0] === value)?.[1] ?? value;
