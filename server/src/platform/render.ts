import type { Column } from '../../../shared/src/index.js';

/** Plain-text rendering of a decoded cell value, used by CSV/XLSX export. */
export function renderValue(column: Pick<Column, 'type'>, value: unknown): string {
  if (value == null) return '';
  switch (column.type) {
    case 'Checkbox':
      return value ? 'true' : 'false';
    case 'Attachment':
      return Array.isArray(value) ? value.map((a) => (a && typeof a === 'object' ? String((a as { url?: unknown }).url ?? '') : String(a))).join(', ') : String(value);
    case 'Links':
      if (Array.isArray(value)) return String(value.length);
      return String(value);
    case 'JSON':
      return typeof value === 'string' ? value : JSON.stringify(value);
    default:
      return renderAny(value);
  }
}

function renderAny(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(renderAny).filter((s) => s !== '').join(', ');
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ('display' in o) return renderAny(o.display);
    if ('url' in o) return renderAny(o.url);
    if ('title' in o) return renderAny(o.title);
    return JSON.stringify(value);
  }
  return String(value);
}

const NUMERIC = new Set(['ID', 'Number', 'Decimal', 'Currency', 'Percent', 'Rating', 'Rollup']);

/** XLSX cells keep numbers numeric; everything else is text. */
export function xlsxValue(column: Pick<Column, 'type'>, value: unknown): string | number | null {
  if (value == null || value === '') return null;
  if ((NUMERIC.has(column.type) || column.type === 'Formula') && typeof value === 'number') return value;
  if (NUMERIC.has(column.type) && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return renderValue(column, value);
}
