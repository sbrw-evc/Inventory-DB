import { describe, expect, it } from 'vitest';
import {
  convertAttachments,
  convertValue,
  formatDuration,
  mapFilterOp,
  mapFilters,
  mapSorts,
  mapViewType,
  parseWidth,
  planColumn,
  relationKey,
  rewriteFormula,
  uniqueTitle,
  type MappedColumnRef,
} from '../src/migrate/mapping.js';
import type { NocoColumn, NocoFilter } from '../src/migrate/nocodbClient.js';
import { fixture } from './migrateNocodbMock.js';

const col = (uidt: string, extra: Partial<NocoColumn> = {}): NocoColumn => ({ id: 'c1', title: 'F', uidt, ...extra });
const ctx = { baseUrl: 'https://nocodb.example.com' };

describe('planColumn (uidt → FieldType)', () => {
  it('keeps directly supported types', () => {
    for (const t of ['SingleLineText', 'LongText', 'Number', 'Checkbox', 'Date', 'DateTime', 'Email', 'URL', 'PhoneNumber', 'Attachment', 'JSON']) {
      const p = planColumn(col(t));
      expect(p).toMatchObject({ kind: 'stored', type: t });
      expect((p as { note?: string }).note).toBeUndefined();
    }
  });

  it('carries number/currency/rating/date options', () => {
    expect(planColumn(col('Decimal', { meta: { precision: 3 } }))).toMatchObject({ type: 'Decimal', options: { precision: 3 } });
    expect(planColumn(col('Currency', { meta: '{"currency_code":"EUR","precision":2}' }))).toMatchObject({
      type: 'Currency',
      options: { currencyCode: 'EUR', precision: 2 },
    });
    expect(planColumn(col('Percent'))).toMatchObject({ type: 'Percent' });
    expect(planColumn(col('Rating', { meta: { max: 10, icon: { full: 'mdi-star' } } }))).toMatchObject({ type: 'Rating', options: { max: 10, icon: 'mdi-star' } });
    expect(planColumn(col('Date', { meta: { date_format: 'DD/MM/YYYY' } }))).toMatchObject({ options: { dateFormat: 'DD/MM/YYYY' } });
  });

  it('maps select options, sorted, with colours', () => {
    const p = planColumn(
      col('SingleSelect', { colOptions: { options: [{ title: 'b', color: '#111', order: 2 }, { title: 'a', order: 1 }, { title: 'a', order: 3 }] } }),
    );
    expect(p).toMatchObject({ kind: 'stored', type: 'SingleSelect' });
    const choices = (p as { options: { choices: { title: string; color: string }[] } }).options.choices;
    expect(choices.map((c) => c.title)).toEqual(['a', 'b']);
    expect(choices[1]!.color).toBe('#111');
    expect(choices[0]!.color).toMatch(/^#/);
  });

  it('converts unsupported types to text/number with a note', () => {
    expect(planColumn(col('RichText'))).toMatchObject({ type: 'LongText', note: expect.any(String) });
    expect(planColumn(col('Year'))).toMatchObject({ type: 'Number', note: expect.any(String) });
    expect(planColumn(col('Time'))).toMatchObject({ type: 'SingleLineText', note: expect.any(String) });
    expect(planColumn(col('Duration'))).toMatchObject({ type: 'SingleLineText', note: expect.any(String) });
    expect(planColumn(col('User'))).toMatchObject({ type: 'SingleLineText', note: expect.any(String) });
    expect(planColumn(col('CreatedBy'))).toMatchObject({ type: 'SingleLineText' });
    expect(planColumn(col('GeoData'))).toMatchObject({ type: 'GeoData' });
    expect(planColumn(col('SpecificDBType'))).toMatchObject({ type: 'SingleLineText' });
    expect(planColumn(col('SomethingNew'))).toMatchObject({ type: 'SingleLineText', note: 'SomethingNew converted to text' });
  });

  it('skips system, key and unsupported virtual columns', () => {
    expect(planColumn(col('ID', { pk: true }))).toMatchObject({ kind: 'skip', systemTarget: 'ID', silent: true });
    expect(planColumn(col('Number', { pk: 1 }))).toMatchObject({ kind: 'skip', systemTarget: 'ID' });
    expect(planColumn(col('CreatedTime', { system: true }))).toMatchObject({ kind: 'skip', systemTarget: 'CreatedTime', silent: true });
    expect(planColumn(col('LastModifiedTime'))).toMatchObject({ kind: 'skip', systemTarget: 'LastModifiedTime', silent: false });
    expect(planColumn(col('ForeignKey', { system: true }))).toMatchObject({ kind: 'skip', silent: true });
    expect(planColumn(col('SingleLineText', { system: true }))).toMatchObject({ kind: 'skip' });
    for (const t of ['Barcode', 'QRCode', 'Button']) expect(planColumn(col(t))).toMatchObject({ kind: 'skip' });
  });

  it('maps links, lookups, rollups and formulas from the fixtures', () => {
    const products = fixture<{ columns: NocoColumn[] }>('table-products').columns;
    const suppliers = fixture<{ columns: NocoColumn[] }>('table-suppliers').columns;
    const byTitle = (cols: NocoColumn[], t: string) => cols.find((c) => c.title === t)!;

    expect(planColumn(byTitle(products, 'Supplier'))).toEqual({ kind: 'link', relation: 'bt', relatedTableId: 'mdsupp02' });
    expect(planColumn(byTitle(suppliers, 'Products'))).toEqual({ kind: 'link', relation: 'hm', relatedTableId: 'mdprod01' });
    expect(relationKey(byTitle(products, 'Supplier'))).toBe(relationKey(byTitle(suppliers, 'Products')));
    expect(planColumn(byTitle(products, 'Supplier Name'))).toEqual({ kind: 'lookup', relationColumnId: 'clpsup09', lookupColumnId: 'clsnam02' });
    expect(planColumn(byTitle(suppliers, 'Product Count'))).toEqual({
      kind: 'rollup',
      relationColumnId: 'clsprd03',
      rollupColumnId: 'clptit02',
      rollupFunction: 'count',
    });
    expect(planColumn(byTitle(products, 'Total'))).toEqual({ kind: 'formula', formula: '{Price} * {Quantity}' });
    expect(planColumn(col('Links', { colOptions: { type: 'mm', fk_related_model_id: 'x', fk_mm_model_id: 'mm1' } }))).toMatchObject({
      relation: 'mm',
    });
    expect(planColumn(col('LinkToAnotherRecord', { colOptions: { type: 'oo', fk_related_model_id: 'x' } }))).toMatchObject({
      relation: 'bt',
      note: expect.any(String),
    });
    expect(planColumn(col('Rollup', { colOptions: { fk_relation_column_id: 'a', fk_rollup_column_id: 'b', rollup_function: 'avgDistinct' } }))).toMatchObject({
      rollupFunction: 'avg',
      note: expect.any(String),
    });
    expect(planColumn(col('Rollup', { colOptions: { fk_relation_column_id: 'a', fk_rollup_column_id: 'b', rollup_function: 'median' } }))).toMatchObject({
      kind: 'skip',
    });
  });
});

describe('formulas and titles', () => {
  it('rewrites id references and renamed titles', () => {
    const titles = new Map([
      ['clA', 'Price'],
      ['clB', 'Qty'],
    ]);
    expect(rewriteFormula('{{clA}} * {{clB}}', titles, new Map())).toBe('{Price} * {Qty}');
    expect(rewriteFormula('{Price} * {Qty}', titles, new Map([['Qty', 'Qty 2']]))).toBe('{Price} * {Qty 2}');
    expect(rewriteFormula('CONCAT({Price}, "x")', titles, new Map())).toBe('CONCAT({Price}, "x")');
  });

  it('makes titles unique case-insensitively', () => {
    const taken = new Set(['title', 'id']);
    expect(uniqueTitle('Name', taken)).toBe('Name');
    expect(uniqueTitle('Title', taken)).toBe('Title 2');
    expect(uniqueTitle('title', taken)).toBe('title 3');
  });
});

describe('views', () => {
  it('maps view types', () => {
    expect([1, 2, 3, 4, 6].map(mapViewType)).toEqual(['form', 'gallery', 'grid', 'kanban', 'calendar']);
    expect(mapViewType(5)).toBe('map');
    expect(mapViewType(9)).toBeNull();
    expect(parseWidth('200px')).toBe(200);
    expect(parseWidth(150)).toBe(150);
    expect(parseWidth(null)).toBeUndefined();
  });
});

describe('filters', () => {
  it('maps comparison ops', () => {
    expect(mapFilterOp('eq', null, 'x', 'SingleLineText')).toEqual({ op: 'eq', value: 'x' });
    expect(mapFilterOp('neq', null, '5', 'Number')).toEqual({ op: 'neq', value: 5 });
    expect(mapFilterOp('like', null, '%abc%', 'SingleLineText')).toEqual({ op: 'like', value: 'abc' });
    expect(mapFilterOp('nlike', null, 'abc', 'LongText')).toEqual({ op: 'nlike', value: 'abc' });
    expect(mapFilterOp('gte', null, '1.5', 'Decimal')).toEqual({ op: 'gte', value: 1.5 });
    expect(mapFilterOp('le', null, '3', 'Number')).toEqual({ op: 'lte', value: 3 });
    for (const op of ['blank', 'empty', 'null']) expect(mapFilterOp(op, null, null, 'SingleLineText')).toEqual({ op: 'blank' });
    for (const op of ['notblank', 'notempty', 'notnull']) expect(mapFilterOp(op, null, null, 'Email')).toEqual({ op: 'notblank' });
    expect(mapFilterOp('checked', null, null, 'Checkbox')).toEqual({ op: 'checked' });
    expect(mapFilterOp('notchecked', null, null, 'Checkbox')).toEqual({ op: 'notchecked' });
    expect(mapFilterOp('eq', null, true, 'Checkbox')).toEqual({ op: 'checked' });
    expect(mapFilterOp('eq', null, false, 'Checkbox')).toEqual({ op: 'notchecked' });
    expect(mapFilterOp('anyof', null, 'a, b', 'MultiSelect')).toEqual({ op: 'anyof', value: ['a', 'b'] });
    expect(mapFilterOp('nallof', null, 'a', 'MultiSelect')).toEqual({ op: 'nallof', value: ['a'] });
    expect(mapFilterOp('anyof', null, 'Hardware,Software', 'SingleSelect')).toEqual({ op: 'anyof', value: ['Hardware', 'Software'] });
  });

  it('maps date sub-ops', () => {
    expect(mapFilterOp('isWithin', 'pastMonth', null, 'Date')).toEqual({ op: 'isWithin', value: 'pastMonth' });
    expect(mapFilterOp('isWithin', 'nextNumberOfDays', 5, 'Date')).toHaveProperty('skip');
    expect(mapFilterOp('eq', 'exactDate', '2024-01-01', 'Date')).toEqual({ op: 'eq', value: '2024-01-01' });
    expect(mapFilterOp('gt', 'today', null, 'DateTime')).toHaveProperty('skip');
    expect(mapFilterOp('btw', null, null, 'Number')).toHaveProperty('skip');
    expect(mapFilterOp('like', null, 'x', 'Number')).toHaveProperty('skip'); // not offered for numbers
  });

  it('maps a nested filter tree', () => {
    const columns = new Map<string, MappedColumnRef>([
      ['clpstk06', { id: 'our_stock', type: 'Checkbox' }],
      ['clppri03', { id: 'our_price', type: 'Decimal' }],
      ['clptag05', { id: 'our_tags', type: 'MultiSelect' }],
      ['clpcrt14', { id: 'our_created', type: 'CreatedTime' }],
    ]);
    const roots = fixture<{ list: NocoFilter[] }>('filters-instock').list;
    roots[1]!.children = fixture<{ list: NocoFilter[] }>('filter-children-grp02').list;
    const { filter, skipped } = mapFilters(roots, columns);
    expect(filter).toEqual({
      logic: 'and',
      children: [
        { columnId: 'our_stock', op: 'checked' },
        {
          logic: 'or',
          children: [
            { columnId: 'our_price', op: 'gt', value: 5 },
            { columnId: 'our_tags', op: 'anyof', value: ['sale', 'eco'] },
          ],
        },
      ],
    });
    expect(skipped).toEqual(['filter relative date comparison "today"']);
    expect(mapFilters([{ id: 'x', fk_column_id: 'missing', comparison_op: 'eq' }], columns)).toEqual({
      filter: null,
      skipped: ['filter on a column that was not migrated'],
    });
  });

  it('maps sorts', () => {
    const columns = new Map<string, MappedColumnRef>([['a', { id: 'A', type: 'Number' }]]);
    expect(
      mapSorts(
        [
          { fk_column_id: 'a', direction: 'desc', order: 2 },
          { fk_column_id: 'zz', direction: 'asc', order: 1 },
        ],
        columns,
      ),
    ).toEqual({ sorts: [{ columnId: 'A', direction: 'desc' }], skipped: ['sort on a column that was not migrated'] });
  });
});

describe('values', () => {
  it('converts scalar values', () => {
    expect(convertValue('Checkbox', 'Checkbox', true, ctx)).toBe(true);
    expect(convertValue('Checkbox', 'Checkbox', 0, ctx)).toBe(false);
    expect(convertValue('Checkbox', 'Checkbox', null, ctx)).toBe(false);
    expect(convertValue('Checkbox', 'Checkbox', '1', ctx)).toBe(true);
    expect(convertValue('Number', 'Number', '42', ctx)).toBe(42);
    expect(convertValue('Decimal', 'Decimal', '1,234.5', ctx)).toBe(1234.5);
    expect(convertValue('Decimal', 'Decimal', '', ctx)).toBeNull();
    expect(convertValue('Year', 'Number', 2024, ctx)).toBe(2024);
    expect(convertValue('SingleSelect', 'SingleSelect', 'Hardware', ctx)).toBe('Hardware');
    expect(convertValue('SingleLineText', 'SingleLineText', undefined, ctx)).toBeUndefined();
  });

  it('converts multi-select strings and arrays', () => {
    expect(convertValue('MultiSelect', 'MultiSelect', 'new,sale', ctx)).toEqual(['new', 'sale']);
    expect(convertValue('MultiSelect', 'MultiSelect', ['a', 'b'], ctx)).toEqual(['a', 'b']);
    expect(convertValue('MultiSelect', 'MultiSelect', null, ctx)).toEqual([]);
  });

  it('converts dates to ISO', () => {
    expect(convertValue('Date', 'Date', '2024-03-01', ctx)).toBe('2024-03-01');
    expect(convertValue('Date', 'Date', '2024-03-01 00:00:00+00:00', ctx)).toBe('2024-03-01');
    expect(convertValue('DateTime', 'DateTime', '2024-03-01 10:00:00+00:00', ctx)).toBe('2024-03-01T10:00:00.000Z');
    expect(convertValue('DateTime', 'DateTime', '2024-03-01T10:00:00+02:00', ctx)).toBe('2024-03-01T08:00:00.000Z');
    expect(convertValue('DateTime', 'DateTime', null, ctx)).toBeNull();
  });

  it('converts attachments, keeping remote URLs', () => {
    const rows = fixture<Record<string, unknown>[]>('records-products');
    expect(convertValue('Attachment', 'Attachment', rows[0]!.Photo, ctx)).toEqual([
      { url: 'https://cdn.example.com/nc/uploads/widget.png', title: 'widget.png', mimetype: 'image/png', size: 1234 },
    ]);
    expect(convertAttachments(rows[2]!.Photo, ctx)).toEqual([
      { url: 'https://nocodb.example.com/download/noco/inventory/Products/Photo/gizmo.jpg', title: 'gizmo.jpg', mimetype: 'image/jpeg', size: 2048 },
    ]);
    expect(convertAttachments('[{"signedUrl":"https://s3/x.pdf?sig=1"}]', ctx)).toEqual([{ url: 'https://s3/x.pdf?sig=1', title: 'x.pdf' }]);
    expect(convertValue('Attachment', 'Attachment', null, ctx)).toEqual([]);
  });

  it('converts JSON and converted types', () => {
    expect(convertValue('JSON', 'JSON', '{"a":1}', ctx)).toEqual({ a: 1 });
    expect(convertValue('JSON', 'JSON', { a: 1 }, ctx)).toEqual({ a: 1 });
    expect(convertValue('User', 'SingleLineText', [{ email: 'a@x.com', display_name: 'Alice' }, { email: 'b@x.com' }], ctx)).toBe('Alice, b@x.com');
    expect(convertValue('CreatedBy', 'SingleLineText', { email: 'c@x.com' }, ctx)).toBe('c@x.com');
    expect(convertValue('User', 'SingleLineText', null, ctx)).toBeNull();
    expect(convertValue('Duration', 'SingleLineText', 3725, ctx)).toBe('1:02:05');
    expect(formatDuration(59)).toBe('0:00:59');
    expect(convertValue('Time', 'SingleLineText', '1999-01-01 10:30:00+00:00', ctx)).toBe('10:30:00');
    expect(convertValue('GeoData', 'SingleLineText', '51.5;-0.12', ctx)).toBe('51.5;-0.12');
    expect(convertValue('Formula', 'LongText', 95, ctx)).toBe('95');
  });
});
