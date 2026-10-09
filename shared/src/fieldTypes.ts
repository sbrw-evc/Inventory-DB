/** Every field (column) type the app supports. Names follow NocoDB's `uidt` values. */
export const FIELD_TYPES = [
  'ID',
  'SingleLineText',
  'LongText',
  'Number',
  'Decimal',
  'Currency',
  'Percent',
  'Rating',
  'Checkbox',
  'Date',
  'DateTime',
  'Email',
  'URL',
  'PhoneNumber',
  'SingleSelect',
  'MultiSelect',
  'Attachment',
  'JSON',
  'CreatedTime',
  'LastModifiedTime',
  'Links',
  'Lookup',
  'Rollup',
  'Formula',
  'GeoData',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Fields computed from other data; they have no physical column. */
export const VIRTUAL_FIELD_TYPES: readonly FieldType[] = ['Links', 'Lookup', 'Rollup', 'Formula'];

/** Fields whose value the system maintains; clients cannot write them. */
export const SYSTEM_FIELD_TYPES: readonly FieldType[] = ['ID', 'CreatedTime', 'LastModifiedTime'];

export const isVirtual = (t: FieldType) => VIRTUAL_FIELD_TYPES.includes(t);
export const isReadOnlyType = (t: FieldType) => isVirtual(t) || SYSTEM_FIELD_TYPES.includes(t);

/** PostgreSQL column type of each stored field type. Dates are ISO-8601 text, checkboxes 0/1. */
export const SQL_TYPE: Partial<Record<FieldType, 'TEXT' | 'BIGINT' | 'INTEGER' | 'DOUBLE PRECISION'>> = {
  SingleLineText: 'TEXT',
  LongText: 'TEXT',
  Number: 'BIGINT',
  Decimal: 'DOUBLE PRECISION',
  Currency: 'DOUBLE PRECISION',
  Percent: 'DOUBLE PRECISION',
  Rating: 'INTEGER',
  Checkbox: 'INTEGER',
  Date: 'TEXT', // YYYY-MM-DD
  DateTime: 'TEXT', // ISO-8601 UTC
  Email: 'TEXT',
  URL: 'TEXT',
  PhoneNumber: 'TEXT',
  SingleSelect: 'TEXT',
  MultiSelect: 'TEXT', // JSON array of option titles
  Attachment: 'TEXT', // JSON array of Attachment
  JSON: 'TEXT',
  GeoData: 'TEXT', // "lat;lng" like NocoDB
};

export const ROLLUP_FUNCTIONS = ['count', 'sum', 'avg', 'min', 'max', 'countDistinct', 'sumDistinct'] as const;
export type RollupFunction = (typeof ROLLUP_FUNCTIONS)[number];

/** Comparison operators, NocoDB-compatible names. */
export const FILTER_OPS = [
  'eq',
  'neq',
  'like', // contains
  'nlike', // does not contain
  'gt',
  'lt',
  'gte',
  'lte',
  'blank',
  'notblank',
  'checked',
  'notchecked',
  'anyof', // select: any of the given options
  'allof',
  'nanyof',
  'nallof',
  'isWithin', // date: value is 'pastWeek' | 'pastMonth' | 'pastYear' | 'nextWeek' | 'nextMonth' | 'nextYear'
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Which filter ops the UI offers for each type family. */
export function opsForType(t: FieldType): FilterOp[] {
  switch (t) {
    case 'Checkbox':
      return ['checked', 'notchecked'];
    case 'SingleSelect':
      return ['eq', 'neq', 'anyof', 'nanyof', 'blank', 'notblank'];
    case 'MultiSelect':
      return ['anyof', 'allof', 'nanyof', 'nallof', 'blank', 'notblank'];
    case 'Number':
    case 'Decimal':
    case 'Currency':
    case 'Percent':
    case 'Rating':
    case 'ID':
    case 'Rollup':
      return ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'blank', 'notblank'];
    case 'Date':
    case 'DateTime':
    case 'CreatedTime':
    case 'LastModifiedTime':
      return ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'isWithin', 'blank', 'notblank'];
    case 'Links':
      return ['blank', 'notblank'];
    case 'GeoData':
      return ['eq', 'blank', 'notblank'];
    default:
      return ['eq', 'neq', 'like', 'nlike', 'blank', 'notblank'];
  }
}
