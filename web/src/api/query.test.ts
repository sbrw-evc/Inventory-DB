import { describe, expect, it } from 'vitest';
import { buildQuery, listQueryString } from './query';

describe('buildQuery', () => {
  it('skips empty values and encodes the rest', () => {
    expect(buildQuery({ a: 1, b: undefined, c: null, d: '', e: 'x y' })).toBe('?a=1&e=x%20y');
    expect(buildQuery({})).toBe('');
  });
  it('joins string arrays and JSON-encodes objects', () => {
    expect(buildQuery({ fields: ['c1', 'c2'] })).toBe('?fields=c1%2Cc2');
    const q = buildQuery({ filter: { logic: 'and', children: [] } });
    expect(decodeURIComponent(q)).toBe('?filter={"logic":"and","children":[]}');
    expect(buildQuery({ fields: [] })).toBe('');
  });
});

describe('listQueryString', () => {
  it('maps a ListQuery to the records endpoint params', () => {
    const s = listQueryString({
      viewId: 'v1',
      offset: 100,
      limit: 50,
      search: '  drill ',
      searchColumnId: 'c9',
      fields: ['c1', 'c2'],
      filter: { logic: 'and', children: [{ columnId: 'c1', op: 'eq', value: 'x' }] },
      sorts: [{ columnId: 'c2', direction: 'desc' }],
    });
    const p = new URLSearchParams(s.slice(1));
    expect(p.get('viewId')).toBe('v1');
    expect(p.get('offset')).toBe('100');
    expect(p.get('limit')).toBe('50');
    expect(p.get('search')).toBe('drill');
    expect(p.get('searchColumnId')).toBe('c9');
    expect(p.get('fields')).toBe('c1,c2');
    expect(JSON.parse(p.get('filter')!).children[0].value).toBe('x');
    expect(JSON.parse(p.get('sorts')!)).toEqual([{ columnId: 'c2', direction: 'desc' }]);
  });
  it('omits empty filter, blank search and its column', () => {
    const p = new URLSearchParams(listQueryString({ search: '  ', searchColumnId: 'c1', filter: { logic: 'and', children: [] } }).slice(1));
    expect(p.has('search')).toBe(false);
    expect(p.has('searchColumnId')).toBe(false);
    expect(p.has('filter')).toBe(false);
  });
});
