/**
 * Record service: list/get/insert/update/delete, links and grouping. All writes run in a transaction and
 * emit bus events after commit.
 */
import type { FilterGroup, GroupResult, ListQuery, ListResult, RecordData, Sort, View } from '../../../shared/src/index.js';
import { SQL_TYPE } from '../../../shared/src/index.js';
import type Database from 'better-sqlite3';
import { dataColumnName, dataTableName, getDb, now, q } from '../db/index.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { bus } from '../events.js';
import { type ColumnMeta, findView, linkInfo, loadColumn, saveColumnOptions, tableRow } from '../meta/store.js';
import { type CoerceOpts, fromStored, toStored } from './codec.js';
import { QueryContext, colExpr, compileFilter, compileSearch, compileSorts, linksDetailExpr } from './query.js';
import { type Frag, join, raw, sql, val } from './sql.js';
import { type Access, assertFilterVisible, assertSortsVisible, assertWritable, hiddenColumnIds, stripRecords } from './access.js';

export interface WriteContext {
  userId?: string | null;
  /** Caller's role for field-level permissions; omitted = full access (internal callers). */
  access?: Access;
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 1000;
const T = 't';

export const isStored = (c: ColumnMeta) => SQL_TYPE[c.type] !== undefined;

function chunks<V>(arr: V[], size = 500): V[][] {
  const out: V[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function run(frag: Frag) {
  return getDb().prepare(frag.sql).run(...frag.params);
}
function all<R>(frag: Frag): R[] {
  return getDb().prepare(frag.sql).all(...frag.params) as R[];
}

function viewFor(tableId: string, viewId: string | undefined): View | null {
  if (!viewId) return null;
  const view = findView(viewId);
  if (!view || view.tableId !== tableId) throw notFound('View');
  return view;
}

interface WhereInput {
  view: View | null;
  filter?: FilterGroup | null;
  search?: string;
  searchColumnId?: string;
  extra?: Frag | null;
  /** Columns the caller can't see: excluded from search */
  hidden?: Set<string>;
}

function buildWhere(qc: QueryContext, tableId: string, w: WhereInput): Frag {
  const parts: Frag[] = [];
  const vf = compileFilter(qc, w.view?.filter, tableId, T, false);
  if (vf) parts.push(sql`(${vf})`);
  const f = compileFilter(qc, w.filter, tableId, T, true);
  if (f) parts.push(sql`(${f})`);
  if (w.search) {
    const s = compileSearch(qc, tableId, T, w.search, w.searchColumnId, w.hidden);
    if (s) parts.push(s);
  }
  if (w.extra) parts.push(sql`(${w.extra})`);
  return parts.length ? join(parts, ' AND ') : raw('1');
}

function pickColumns(cols: ColumnMeta[], fields: string[] | undefined): ColumnMeta[] {
  if (!fields?.length) return cols;
  return fields.map((f) => {
    const c = cols.find((x) => x.id === f) ?? cols.find((x) => x.title.toLowerCase() === f.toLowerCase());
    if (!c) throw badRequest(`Unknown field ${f}`);
    return c;
  });
}

function selectList(qc: QueryContext, cols: ColumnMeta[], detailedLinks: boolean): Frag {
  return join(
    [raw(`${T}.id AS id`), ...cols.map((c, i) => sql`${c.type === 'Links' && detailedLinks ? linksDetailExpr(qc, c, T) : colExpr(qc, c, T)} AS ${raw(`f${i}`)}`)],
    ', ',
  );
}

function decodeRows(qc: QueryContext, cols: ColumnMeta[], rows: Record<string, unknown>[], detailedLinks: boolean): RecordData[] {
  const resolve = (id: string) => qc.column(id);
  return rows.map((r) => {
    const rec: RecordData = { id: Number(r.id) };
    cols.forEach((c, i) => {
      rec[c.id] = fromStored(c, r[`f${i}`], resolve, detailedLinks);
    });
    return rec;
  });
}

/** Rejects (400) request filters/sorts/search/group fields naming columns the caller can't see. */
function checkVisible(hidden: Set<string>, q: { filter?: FilterGroup | null; sorts?: Sort[]; searchColumnId?: string; fields?: string[] }) {
  if (!hidden.size) return;
  assertFilterVisible(q.filter, hidden);
  assertSortsVisible(q.sorts, hidden);
  if (q.searchColumnId && hidden.has(q.searchColumnId)) throw badRequest(`Unknown search field ${q.searchColumnId}`);
}

function query(tableId: string, lq: ListQuery, extra?: Frag | null, access?: Access): ListResult {
  const qc = new QueryContext();
  tableRow(tableId);
  const hidden = hiddenColumnIds(tableId, access, (id) => qc.columns(id));
  checkVisible(hidden, lq);
  const visibleCols = hidden.size ? qc.columns(tableId).filter((c) => !hidden.has(c.id)) : qc.columns(tableId);
  const cols = pickColumns(visibleCols, lq.fields);
  const view = viewFor(tableId, lq.viewId);
  const offset = Math.max(0, Math.floor(Number(lq.offset) || 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(lq.limit) || DEFAULT_LIMIT)));
  const where = buildWhere(qc, tableId, { view, filter: lq.filter, search: lq.search, searchColumnId: lq.searchColumnId, extra, hidden });
  const sorts = lq.sorts ?? view?.sorts ?? [];
  const order = compileSorts(qc, sorts, tableId, T, lq.sorts !== undefined);
  const from = raw(`${q(dataTableName(tableId))} ${T}`);
  const rows = all<Record<string, unknown>>(
    sql`SELECT ${selectList(qc, cols, false)} FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ${val(limit)} OFFSET ${val(offset)}`,
  );
  const total = all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`)[0].n;
  const list = decodeRows(qc, cols, rows, false);
  return { list, pageInfo: { totalRows: total, offset, limit, isLastPage: offset + list.length >= total } };
}

/** List records of a table, applying the view's filter/sorts plus the query's own filter/sorts/search. */
export function listRecords(tableId: string, lq: ListQuery = {}, access?: Access): ListResult {
  return query(tableId, lq, null, access);
}

/** Records by id, in the given order (missing ids are skipped). Links are returned as [{id, display}]. */
export function fetchRecords(tableId: string, ids: number[], detailedLinks = true): RecordData[] {
  if (!ids.length) return [];
  const qc = new QueryContext();
  const cols = qc.columns(tableId);
  const byId = new Map<number, RecordData>();
  for (const part of chunks([...new Set(ids)])) {
    const rows = all<Record<string, unknown>>(
      sql`SELECT ${selectList(qc, cols, detailedLinks)} FROM ${raw(`${q(dataTableName(tableId))} ${T}`)} WHERE ${raw(T)}.id IN (${join(part.map(val), ', ')})`,
    );
    for (const r of decodeRows(qc, cols, rows, detailedLinks)) byId.set(r.id, r);
  }
  return ids.map((id) => byId.get(id)).filter((r): r is RecordData => !!r);
}

export function getRecord(tableId: string, id: number, access?: Access): RecordData {
  tableRow(tableId);
  const [rec] = fetchRecords(tableId, [Number(id)]);
  if (!rec) throw notFound('Record');
  return stripRecords([rec], hiddenColumnIds(tableId, access))[0];
}

/** Decoded values of one column for every row (used by type conversion). */
export function selectColumnValues(tableId: string, col: ColumnMeta, detailedLinks = true): { id: number; value: unknown }[] {
  const qc = new QueryContext();
  qc.put(col);
  const rows = all<Record<string, unknown>>(
    sql`SELECT ${selectList(qc, [col], detailedLinks)} FROM ${raw(`${q(dataTableName(tableId))} ${T}`)}`,
  );
  return decodeRows(qc, [col], rows, detailedLinks).map((r) => ({ id: r.id, value: r[col.id] }));
}

// ---------------------------------------------------------------------------------------------------------------
// Writes

function toId(v: unknown, what = 'id'): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw badRequest(`Invalid ${what}: ${JSON.stringify(v)}`);
  return n;
}

function parseLinkIds(v: unknown, col: ColumnMeta): number[] {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [v];
  return arr.map((x) => toId(x && typeof x === 'object' ? (x as { id: unknown }).id : x, `linked record id for "${col.title}"`));
}

/** Map a row keyed by column id or title to column id -> value (ids win on conflict). */
function normalizeRow(row: Record<string, unknown>, cols: ColumnMeta[]): Map<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw badRequest('Each record must be an object');
  const out = new Map<string, unknown>();
  const byId = new Map(cols.map((c) => [c.id, c]));
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id' || byId.has(k)) continue;
    const c = cols.find((x) => x.title === k) ?? cols.find((x) => x.title.toLowerCase() === k.toLowerCase());
    if (c) out.set(c.id, v);
  }
  for (const [k, v] of Object.entries(row)) if (byId.has(k)) out.set(k, v);
  return out;
}

function requireValue(c: ColumnMeta, stored: unknown) {
  if (c.required && c.type !== 'Checkbox' && (stored == null || stored === '')) throw badRequest(`Field "${c.title}" is required`);
}

type LinkMode = 'replace' | 'add' | 'remove';

function writeLinks(col: ColumnMeta, recordId: number, ids: number[], mode: LinkMode) {
  const li = linkInfo(col);
  const J = q(li.junction);
  const unique = [...new Set(ids)];
  if (mode !== 'remove' && unique.length) {
    const found = new Set<number>();
    for (const part of chunks(unique))
      for (const r of all<{ id: number }>(sql`SELECT id FROM ${raw(q(dataTableName(li.relatedTableId)))} WHERE id IN (${join(part.map(val), ', ')})`))
        found.add(r.id);
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length) throw badRequest(`Linked record(s) not found for "${col.title}": ${missing.join(', ')}`);
  }
  const relation = col.options.relation ?? 'mm';
  if (relation === 'bt' && mode !== 'remove' && unique.length > 1) throw badRequest(`"${col.title}" can link to only one record`);
  if (mode === 'replace' || (relation === 'bt' && mode === 'add' && unique.length)) run(sql`DELETE FROM ${raw(J)} WHERE ${raw(li.self)} = ${val(recordId)}`);
  if (mode === 'remove') {
    for (const part of chunks(unique))
      run(sql`DELETE FROM ${raw(J)} WHERE ${raw(li.self)} = ${val(recordId)} AND ${raw(li.other)} IN (${join(part.map(val), ', ')})`);
    return;
  }
  const db = getDb();
  const clear = relation === 'hm' ? db.prepare(`DELETE FROM ${J} WHERE ${li.other} = ? AND ${li.self} != ?`) : null;
  const ins = db.prepare(`INSERT OR IGNORE INTO ${J} (${li.self}, ${li.other}) VALUES (?, ?)`);
  for (const id of unique) {
    clear?.run(id, recordId);
    ins.run(recordId, id);
  }
}

function coerceOpts(dirty: Set<ColumnMeta>): CoerceOpts {
  return { strict: true, onNewChoice: (c) => dirty.add(c) };
}

/** Insert records. Keys may be column ids or titles; Links values are arrays of record ids. */
export function insertRecords(tableId: string, rows: Record<string, unknown>[], ctx: WriteContext = {}): RecordData[] {
  const { base_id: baseId } = tableRow(tableId);
  const qc = new QueryContext();
  const cols = qc.columns(tableId);
  const hidden = hiddenColumnIds(tableId, ctx.access, (id) => qc.columns(id));
  const db = getDb();
  const dirty = new Set<ColumnMeta>();
  const opts = coerceOpts(dirty);
  const ts = now();
  const ids = db.transaction(() => {
    const out: number[] = [];
    const stmts = new Map<string, Database.Statement<unknown[]>>();
    for (const row of rows) {
      const values = normalizeRow(row, cols);
      for (const colId of values.keys()) assertWritable(cols.find((x) => x.id === colId)!, ctx.access, hidden);
      const names = ['created_at', 'updated_at', 'created_by'];
      const params: unknown[] = [ts, ts, ctx.userId ?? null];
      if (row.id != null && row.id !== '') {
        const id = toId(row.id);
        if (db.prepare(`SELECT 1 FROM ${q(dataTableName(tableId))} WHERE id = ?`).get(id)) throw conflict(`Record ${id} already exists`);
        names.unshift('id');
        params.unshift(id);
      }
      const links: [ColumnMeta, number[]][] = [];
      for (const c of cols) {
        if (c.type === 'Links') {
          const linkIds = values.has(c.id) ? parseLinkIds(values.get(c.id), c) : [];
          if (c.required && !linkIds.length) throw badRequest(`Field "${c.title}" is required`);
          if (linkIds.length) links.push([c, linkIds]);
          continue;
        }
        if (!isStored(c)) continue;
        const stored = toStored(c, values.has(c.id) ? values.get(c.id) : c.defaultValue, opts);
        requireValue(c, stored);
        if (stored !== null) {
          names.push(dataColumnName(c.id));
          params.push(stored);
        }
      }
      const key = names.join(',');
      let stmt = stmts.get(key);
      if (!stmt) {
        stmt = db.prepare(`INSERT INTO ${q(dataTableName(tableId))} (${names.map(q).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`);
        stmts.set(key, stmt);
      }
      const id = Number(stmt.run(...params).lastInsertRowid);
      for (const [c, linkIds] of links) writeLinks(c, id, linkIds, 'add');
      out.push(id);
    }
    for (const c of dirty) saveColumnOptions(c.id, c.options);
    return out;
  })();
  const records = fetchRecords(tableId, ids);
  if (records.length) bus.emit('record.insert', { baseId, tableId, userId: ctx.userId ?? null }, records);
  return stripRecords(records, hidden);
}

/** Update records; each row needs `id`. Only the given fields change. Links values replace the link set. */
export function updateRecords(tableId: string, rows: Record<string, unknown>[], ctx: WriteContext = {}): RecordData[] {
  const { base_id: baseId } = tableRow(tableId);
  const qc = new QueryContext();
  const cols = qc.columns(tableId);
  const hidden = hiddenColumnIds(tableId, ctx.access, (id) => qc.columns(id));
  for (const r of rows) {
    if (!r || typeof r !== 'object') throw badRequest('Each record must be an object');
    for (const colId of normalizeRow(r, cols).keys()) assertWritable(cols.find((x) => x.id === colId)!, ctx.access, hidden);
  }
  const ids = rows.map((r) => {
    if (!r || typeof r !== 'object') throw badRequest('Each record must be an object');
    return toId(r.id);
  });
  const before = fetchRecords(tableId, ids);
  const beforeById = new Map(before.map((r) => [r.id, r]));
  const missing = ids.find((id) => !beforeById.has(id));
  if (missing) throw notFound(`Record ${missing}`);
  const db = getDb();
  const dirty = new Set<ColumnMeta>();
  const opts = coerceOpts(dirty);
  const ts = now();
  db.transaction(() => {
    rows.forEach((row, i) => {
      const id = ids[i];
      const values = normalizeRow(row, cols);
      const sets: Frag[] = [sql`updated_at = ${val(ts)}`];
      for (const [colId, v] of values) {
        const c = cols.find((x) => x.id === colId)!;
        if (c.type === 'Links') {
          const linkIds = parseLinkIds(v, c);
          if (c.required && !linkIds.length) throw badRequest(`Field "${c.title}" is required`);
          writeLinks(c, id, linkIds, 'replace');
          continue;
        }
        if (!isStored(c)) continue;
        const stored = toStored(c, v, opts);
        requireValue(c, stored);
        sets.push(sql`${raw(q(dataColumnName(c.id)))} = ${val(stored)}`);
      }
      run(sql`UPDATE ${raw(q(dataTableName(tableId)))} SET ${join(sets, ', ')} WHERE id = ${val(id)}`);
    });
    for (const c of dirty) saveColumnOptions(c.id, c.options);
  })();
  const after = fetchRecords(tableId, ids);
  const changes = after.map((a) => ({ before: beforeById.get(a.id)!, after: a }));
  if (changes.length) bus.emit('record.update', { baseId, tableId, userId: ctx.userId ?? null }, changes);
  return stripRecords(after, hidden);
}

/** Delete records (and their links). Returns the number deleted. */
export function deleteRecords(tableId: string, ids: unknown[], ctx: WriteContext = {}): number {
  const { base_id: baseId } = tableRow(tableId);
  const numIds = ids.map((x) => toId(x));
  const before = fetchRecords(tableId, numIds);
  if (!before.length) return 0;
  const qc = new QueryContext();
  const links = qc.columns(tableId).filter((c) => c.type === 'Links');
  const existing = before.map((r) => r.id);
  getDb().transaction(() => {
    for (const part of chunks(existing)) {
      const list = join(part.map(val), ', ');
      run(sql`DELETE FROM ${raw(q(dataTableName(tableId)))} WHERE id IN (${list})`);
      for (const c of links) {
        const li = linkInfo(c);
        run(sql`DELETE FROM ${raw(q(li.junction))} WHERE ${raw(li.self)} IN (${list})`);
      }
    }
  })();
  bus.emit('record.delete', { baseId, tableId, userId: ctx.userId ?? null }, before);
  return before.length;
}

function linkTarget(columnId: string, recordId: number) {
  const col = loadColumn(columnId);
  if (col.type !== 'Links') throw badRequest(`Field "${col.title}" is not a Links field`);
  const id = toId(recordId, 'record id');
  if (!getDb().prepare(`SELECT 1 FROM ${q(dataTableName(col.tableId))} WHERE id = ?`).get(id)) throw notFound('Record');
  return { col, id, baseId: tableRow(col.tableId).base_id };
}

function changeLinks(columnId: string, recordId: number, ids: unknown[], ctx: WriteContext, unlink: boolean) {
  const { col, id, baseId } = linkTarget(columnId, recordId);
  assertWritable(col, ctx.access, hiddenColumnIds(col.tableId, ctx.access));
  if (!Array.isArray(ids)) throw badRequest('ids must be an array');
  const linkIds = parseLinkIds(ids, col);
  getDb().transaction(() => {
    writeLinks(col, id, linkIds, unlink ? 'remove' : 'add');
    getDb().prepare(`UPDATE ${q(dataTableName(col.tableId))} SET updated_at = ? WHERE id = ?`).run(now(), id);
  })();
  bus.emit('record.link', { baseId, tableId: col.tableId, userId: ctx.userId ?? null, columnId: col.id, recordId: id, linkedIds: linkIds, unlink });
}

export function linkRecords(columnId: string, recordId: number, ids: number[], ctx: WriteContext = {}): void {
  changeLinks(columnId, recordId, ids, ctx, false);
}

export function unlinkRecords(columnId: string, recordId: number, ids: number[], ctx: WriteContext = {}): void {
  changeLinks(columnId, recordId, ids, ctx, true);
}

/**
 * Records of the related table linked to `recordId` through `columnId`.
 * With `notLinked: true`, the related records that are NOT linked (for a link picker).
 */
export function listLinked(
  columnId: string,
  recordId: number,
  opts: { offset?: number; limit?: number; search?: string; notLinked?: boolean } = {},
  access?: Access,
): ListResult {
  const { col, id } = linkTarget(columnId, recordId);
  if (hiddenColumnIds(col.tableId, access).has(col.id)) throw notFound('Column');
  const li = linkInfo(col);
  const sub = sql`SELECT ${raw(li.other)} FROM ${raw(q(li.junction))} WHERE ${raw(li.self)} = ${val(id)}`;
  const extra = opts.notLinked ? sql`${raw(T)}.id NOT IN (${sub})` : sql`${raw(T)}.id IN (${sub})`;
  return query(li.relatedTableId, { offset: opts.offset, limit: opts.limit, search: opts.search }, extra, access);
}

/** Distinct values of a column with record counts (kanban stacks, grid group-by). */
export function groupRecords(
  tableId: string,
  opts: { viewId?: string; columnId: string; filter?: FilterGroup; search?: string },
  access?: Access,
): GroupResult[] {
  tableRow(tableId);
  const qc = new QueryContext();
  const hidden = hiddenColumnIds(tableId, access, (id) => qc.columns(id));
  checkVisible(hidden, { filter: opts.filter });
  const col = qc.columns(tableId).find((c) => c.id === opts.columnId && !hidden.has(c.id));
  if (!col) throw badRequest(`Unknown field ${opts.columnId}`);
  const view = viewFor(tableId, opts.viewId);
  const where = buildWhere(qc, tableId, { view, filter: opts.filter, search: opts.search, hidden });
  const rows = all<{ v: unknown; n: number }>(
    sql`SELECT ${colExpr(qc, col, T)} AS v, COUNT(*) AS n FROM ${raw(`${q(dataTableName(tableId))} ${T}`)} WHERE ${where} GROUP BY 1 ORDER BY 1`,
  );
  const resolve = (id: string) => qc.column(id);
  const out = rows.map((r) => ({ value: fromStored(col, r.v, resolve), count: r.n }));
  if (col.type === 'SingleSelect') {
    const order = new Map((col.options.choices ?? []).map((c, i) => [c.title, i]));
    out.sort((a, b) => (a.value == null ? -1 : (order.get(a.value as string) ?? 1e9)) - (b.value == null ? -1 : (order.get(b.value as string) ?? 1e9)));
  }
  return out;
}
