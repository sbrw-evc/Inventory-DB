import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { convertValue, inferType } from '../src/platform/infer.js';
import { normalizeHeaders, parseUpload } from '../src/platform/import.js';
import { createTestApp, signUpUser } from './helpers.js';
import { addMember, multipart, seedBase } from './platform-fixtures.js';

describe('type inference', () => {
  it('infers common types', () => {
    expect(inferType(['1', '22', '-3']).type).toBe('Number');
    expect(inferType(['007', '008']).type).toBe('SingleLineText');
    expect(inferType(['1.5', '2', '3.25'])).toEqual({ type: 'Decimal', options: { precision: 2 } });
    expect(inferType(['$1,200.50', '$3.00']).type).toBe('Currency');
    expect(inferType(['yes', 'No', 'TRUE', '']).type).toBe('Checkbox');
    expect(inferType(['2024-01-02', '2024-02-03']).type).toBe('Date');
    expect(inferType(['2024-01-02T10:00:00Z', '2024-01-02']).type).toBe('DateTime');
    expect(inferType([new Date('2024-01-02T00:00:00Z')]).type).toBe('Date');
    expect(inferType(['a@b.co', 'c@d.org']).type).toBe('Email');
    expect(inferType(['https://x.com', 'http://y.org/a']).type).toBe('URL');
    const sel = inferType(['In', 'Out', 'In', 'Out', 'Adjustment', 'In']);
    expect(sel.type).toBe('SingleSelect');
    expect(sel.options?.choices?.map((c) => c.title)).toEqual(['In', 'Out', 'Adjustment']);
    expect(inferType(['In', 'Out', 'In', 'Out'], true).type).toBe('SingleLineText'); // primary never a select
    expect(inferType(['alpha', 'beta', 'gamma']).type).toBe('SingleLineText'); // not repeated
    const multi = inferType(['red, blue', 'blue', 'green, red', 'red']);
    expect(multi.type).toBe('MultiSelect');
    expect(multi.options?.choices?.map((c) => c.title)).toEqual(['red', 'blue', 'green']);
    expect(inferType(['line one\nline two']).type).toBe('LongText');
    expect(inferType(['', null]).type).toBe('SingleLineText');
  });

  it('converts values', () => {
    expect(convertValue('Number', '1,234')).toBe(1234);
    expect(convertValue('Currency', '$1,200.50')).toBe(1200.5);
    expect(convertValue('Checkbox', 'Yes')).toBe(true);
    expect(convertValue('MultiSelect', 'a, b')).toEqual(['a', 'b']);
    expect(convertValue('Date', new Date('2024-03-04T00:00:00Z'))).toBe('2024-03-04');
    expect(convertValue('SingleLineText', '')).toBeNull();
  });

  it('normalizes headers', () => {
    expect(normalizeHeaders(['Name', '', 'name', 'Id', null])).toEqual(['Name', 'Field 2', 'name (2)', 'Id (imported)', 'Field 5']);
  });
});

describe('parsing', () => {
  it('parses CSV (with BOM), JSON and XLSX', async () => {
    const csv = await parseUpload('stock.csv', Buffer.from('﻿Name,Qty\r\n"Bolt, M4",5\r\nNut,7\r\n\r\n'));
    expect(csv).toEqual([{ name: 'stock', headers: ['Name', 'Qty'], rows: [['Bolt, M4', '5'], ['Nut', '7']] }]);

    const json = await parseUpload('x.json', Buffer.from(JSON.stringify([{ a: 1, tags: ['x', 'y'] }, { b: { c: 1 } }])));
    expect(json[0].headers).toEqual(['a', 'tags', 'b']);
    expect(json[0].rows).toEqual([
      [1, 'x, y', undefined],
      [undefined, undefined, '{"c":1}'],
    ]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Items');
    ws.addRow(['Name', 'Price', 'When', 'Link']);
    ws.addRow(['Widget', 9.5, new Date('2024-05-06T00:00:00Z'), { text: 'site', hyperlink: 'https://x.com' }]);
    ws.addRow([{ richText: [{ text: 'Gad' }, { text: 'get' }] }, { formula: '1+1', result: 2 }, null, null]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const sheets = await parseUpload('book.xlsx', buf);
    expect(sheets[0].name).toBe('Items');
    expect(sheets[0].headers).toEqual(['Name', 'Price', 'When', 'Link']);
    expect(sheets[0].rows[0][0]).toBe('Widget');
    expect(sheets[0].rows[0][2]).toBeInstanceOf(Date);
    expect(sheets[0].rows[0][3]).toBe('site');
    expect(sheets[0].rows[1].slice(0, 2)).toEqual(['Gadget', 2]);

    await expect(parseUpload('x.pdf', Buffer.from(''))).rejects.toThrow(/Unsupported/);
  });
});

describe('import preview endpoint', () => {
  it('returns headers, samples and inferred types; requires editor', async () => {
    const app = await createTestApp();
    const owner = await signUpUser(app);
    const viewer = await signUpUser(app);
    const s = seedBase(owner.userId);
    addMember(s.baseId, viewer.userId, 'viewer');
    const csv = 'Name,Qty,Type\nA,1,In\nB,2,Out\nC,3,In\nD,4,Out\n';
    const mp = multipart({}, { name: 'moves.csv', content: csv, type: 'text/csv' });
    const url = `/api/v1/bases/${s.baseId}/import/preview`;

    const denied = await app.inject({ method: 'POST', url, headers: { ...viewer.headers, ...mp.headers }, payload: mp.payload });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({ method: 'POST', url, headers: { ...owner.headers, ...mp.headers }, payload: mp.payload });
    expect(res.statusCode).toBe(200);
    const [sheet] = res.json().sheets;
    expect(sheet).toMatchObject({ name: 'moves', headers: ['Name', 'Qty', 'Type'], rowCount: 4, inferredTypes: ['SingleLineText', 'Number', 'SingleSelect'] });
    expect(sheet.sampleRows[0]).toEqual(['A', '1', 'In']);
  });
});
