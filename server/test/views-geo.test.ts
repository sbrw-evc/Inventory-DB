import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Base, Table, View } from '../../shared/src/index.js';
import { parseGeo } from '../../shared/src/index.js';
import { createTestApp, signUpUser } from './helpers.js';

let app: FastifyInstance;
let h: Record<string, string>;
let baseId: string;

async function call(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: h, payload: payload as object });
  return { status: res.statusCode, body: res.body ? (res.json() as any) : null };
}
async function ok<T = any>(method: string, url: string, payload?: unknown): Promise<T> {
  const r = await call(method, url, payload);
  if (r.status !== 200) throw new Error(`${method} ${url} -> ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));

beforeAll(async () => {
  app = await createTestApp();
  h = (await signUpUser(app, 'geo@example.com')).headers;
  baseId = (await ok<Base>('POST', '/bases', { title: 'Geo' })).id;
});

describe('GeoData', () => {
  it('parses lat;lng in several shapes', () => {
    expect(parseGeo('51.5;-0.12')).toEqual({ lat: 51.5, lng: -0.12 });
    expect(parseGeo('51.5, -0.12')).toEqual({ lat: 51.5, lng: -0.12 });
    expect(parseGeo([1, 2])).toEqual({ lat: 1, lng: 2 });
    expect(parseGeo({ lat: '3', lng: 4 })).toEqual({ lat: 3, lng: 4 });
    expect(parseGeo('91;0')).toBeNull();
    expect(parseGeo('0;181')).toBeNull();
    expect(parseGeo('abc')).toBeNull();
    expect(parseGeo('')).toBeNull();
  });

  it('stores "lat;lng", validates and filters with eq/blank/notblank', async () => {
    const t = await ok<Table>('POST', `/bases/${baseId}/tables`, {
      title: 'Sites',
      columns: [
        { title: 'Name', type: 'SingleLineText' },
        { title: 'Where', type: 'GeoData' },
      ],
    });
    const geo = t.columns.find((c) => c.title === 'Where')!.id;
    const a = await ok('POST', `/tables/${t.id}/records`, { Name: 'London', Where: '51.5, -0.12' });
    expect(a[geo]).toBe('51.5;-0.12');
    await ok('POST', `/tables/${t.id}/records`, { Name: 'Paris', Where: { lat: 48.85, lng: 2.35 } });
    await ok('POST', `/tables/${t.id}/records`, { Name: 'Nowhere' });
    expect((await call('POST', `/tables/${t.id}/records`, { Name: 'Bad', Where: '100;0' })).status).toBe(400);

    const name = t.columns.find((c) => c.title === 'Name')!.id;
    const names = async (filter: unknown) => (await ok(`GET`, `/tables/${t.id}/records?filter=${enc(filter)}`)).list.map((r: any) => r[name]);
    expect(await names({ logic: 'and', children: [{ columnId: geo, op: 'eq', value: '48.85;2.35' }] })).toEqual(['Paris']);
    expect(await names({ logic: 'and', children: [{ columnId: geo, op: 'blank' }] })).toEqual(['Nowhere']);
    expect(await names({ logic: 'and', children: [{ columnId: geo, op: 'notblank' }] })).toEqual(['London', 'Paris']);
    expect((await call('GET', `/tables/${t.id}/records?filter=${enc({ logic: 'and', children: [{ columnId: geo, op: 'like', value: '5' }] })}`)).status).toBe(400);
  });
});

describe('timeline and map views', () => {
  it('defaults start/end dates, scale and the geo field', async () => {
    const t = await ok<Table>('POST', `/bases/${baseId}/tables`, {
      title: 'Projects',
      columns: [
        { title: 'Name', type: 'SingleLineText' },
        { title: 'Start', type: 'Date' },
        { title: 'End', type: 'DateTime' },
        { title: 'Site', type: 'GeoData' },
      ],
    });
    const id = (title: string) => t.columns.find((c) => c.title === title)!.id;
    const tl = await ok<View>('POST', `/tables/${t.id}/views`, { title: 'Plan', type: 'timeline' });
    expect(tl.meta).toMatchObject({ dateColumnId: id('Start'), endDateColumnId: id('End'), timelineScale: 'week' });
    const map = await ok<View>('POST', `/tables/${t.id}/views`, { title: 'Map', type: 'map' });
    expect(map.meta.geoColumnId).toBe(id('Site'));
    const cal = await ok<View>('POST', `/tables/${t.id}/views`, { title: 'Cal', type: 'calendar' });
    expect(cal.meta.dateColumnId).toBe(id('Start'));
    expect(cal.meta.endDateColumnId).toBeUndefined();

    // Clearing the end date sticks; deleting the geo field clears geoColumnId.
    const cleared = await ok<View>('PATCH', `/views/${tl.id}`, { meta: { endDateColumnId: null } });
    expect(cleared.meta.endDateColumnId).toBeUndefined();
    await ok('POST', `/tables/${t.id}/columns`, { title: 'Due', type: 'Date' });
    expect((await ok<View>('GET', `/views/${tl.id}`)).meta.endDateColumnId).toBeUndefined();
    await ok('DELETE', `/columns/${id('Site')}`);
    expect((await ok<View>('GET', `/views/${map.id}`)).meta.geoColumnId).toBeUndefined();
    expect((await call('POST', `/tables/${t.id}/views`, { title: 'Bad', type: 'gantt' })).status).toBe(400);
  });
});
