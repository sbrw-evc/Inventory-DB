import { describe, expect, it } from 'vitest';
import { apiParams, changedKeys, compareAddr, contrastText, elevationBlocks, normalizeMonitoring, plainText, statusTone, toCsv, type ElevationUnit } from './format';
import { dictionaries, fieldLabel, t, typeLabel } from './i18n';

describe('netbox format helpers', () => {
  it('maps statuses to design tones', () => {
    expect(statusTone('active')).toBe('ok');
    expect(statusTone('planned')).toBe('info');
    expect(statusTone('reserved')).toBe('warning');
    expect(statusTone('deprecated')).toBe('critical');
    expect(statusTone('offline')).toBe('neutral');
  });

  it('renders values and CSV', () => {
    const row = {
      name: 'sw1, core',
      status: { value: 'active', label: 'Active' },
      site: { id: 1, url: '/x', display: 'HQ' },
      tags: [{ id: 1, url: '/t', display: 'a' }, { id: 2, url: '/t', display: 'b' }],
      a: [{ object_type: 'dcim.interface', object_id: 3, object: { id: 3, url: '/i', display: 'eth0', device: { id: 1, url: '/d', display: 'sw1' } } }],
    };
    expect(plainText(row.a)).toBe('sw1 eth0');
    expect(toCsv([row], ['name', 'status', 'site', 'tags'])).toBe('name,status,site,tags\n"sw1, core",Active,HQ,"a, b"');
  });

  it('groups rack units into device blocks', () => {
    const dev = (id: number) => ({ id, url: '', display: `d${id}`, position: 1, u_height: 2 });
    const units: ElevationUnit[] = [
      { id: 4, name: 'U4', occupied: false, device: null },
      { id: 3, name: 'U3', occupied: true, device: dev(1) },
      { id: 2, name: 'U2', occupied: true, device: dev(1) },
      { id: 1, name: 'U1', occupied: true, device: dev(2) },
    ];
    expect(elevationBlocks(units).map((b) => [b.row, b.span, b.label])).toEqual([
      [0, 1, 'U4'],
      [1, 2, 'd1'],
      [3, 1, 'd2'],
    ]);
  });

  it('normalises monitoring status payloads', () => {
    expect(normalizeMonitoring({ results: { '5': { status: 'critical', open_alerts: 2, incident_url: 'http://u/1' } } }).get(5)).toEqual({
      status: 'critical',
      open_alerts: 2,
      incident_url: 'http://u/1',
    });
    expect(normalizeMonitoring([{ object_id: 7, status: 'ok' }]).get(7)?.status).toBe('ok');
  });

  it('strips UI-only params and diffs snapshots', () => {
    expect(apiParams(new URLSearchParams('status=active&status=planned&_sel=4&q='))).toEqual({ status: ['active', 'planned'] });
    expect(changedKeys({ a: 1, b: 2, last_updated: 'x' }, { a: 1, b: 3, last_updated: 'y' })).toEqual(['b']);
  });

  it('sorts addresses numerically and picks readable text colours', () => {
    expect(['10.0.0.10/24', '10.0.0.9/24', '2001:db8::/32', '10.0.0.0/16'].sort(compareAddr)).toEqual(['10.0.0.0/16', '10.0.0.9/24', '10.0.0.10/24', '2001:db8::/32']);
    expect(compareAddr('2001:db8::1/64', '2001:db8::/64')).toBeGreaterThan(0);
    expect(contrastText('ffffff')).toBe('#222222');
    expect(contrastText('0b4884')).toBe('#ffffff');
  });

  it('has every UI string in both languages', () => {
    for (const d of Object.values(dictionaries)) for (const [k, [en, ru]] of Object.entries(d)) expect(en && ru, k).toBeTruthy();
    expect(t('selected', { n: 3 }, 'ru')).toBe('Выбрано: 3');
    expect(typeLabel('devices', undefined, 'ru')).toBe('Устройства');
    expect(fieldLabel('some_new_field', 'en')).toBe('Some new field');
  });
});
