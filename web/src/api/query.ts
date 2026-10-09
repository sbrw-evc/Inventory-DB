import type { ListQuery } from '@shared';

export type QueryValue = string | number | boolean | null | undefined | object;

/**
 * Builds a query string (with leading `?`, or '' when empty).
 * Skips null/undefined/'' values, JSON-encodes objects and joins string arrays with commas.
 */
export function buildQuery(params: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null || raw === '') continue;
    let value: string;
    if (Array.isArray(raw) && raw.every((v) => typeof v === 'string' || typeof v === 'number')) {
      if (raw.length === 0) continue;
      value = raw.join(',');
    } else if (typeof raw === 'object') {
      value = JSON.stringify(raw);
    } else {
      value = String(raw);
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Maps a typed ListQuery to the records endpoint's query params. */
export function listQueryParams(q: ListQuery): Record<string, QueryValue> {
  return {
    viewId: q.viewId,
    offset: q.offset,
    limit: q.limit,
    search: q.search?.trim() || undefined,
    searchColumnId: q.search?.trim() ? q.searchColumnId : undefined,
    fields: q.fields && q.fields.length ? q.fields.join(',') : undefined,
    filter: q.filter && q.filter.children.length ? q.filter : undefined,
    // Sorts override the view's sorts, so an empty array is meaningful only when explicitly given.
    sorts: q.sorts ? q.sorts : undefined,
  };
}

export function listQueryString(q: ListQuery): string {
  return buildQuery(listQueryParams(q));
}
