/**
 * Meta service: bases, tables, columns (fields) and views, including the physical DDL for user tables.
 * Other modules (platform, import, NocoDB migration) call these functions directly.
 */
import type {
  Base,
  Column,
  ColumnInput,
  ColumnOptions,
  FieldType,
  FilterGroup,
  SelectOption,
  Sort,
  Table,
  View,
  ViewColumn,
  ViewMeta,
  ViewType,
} from '../../../shared/src/index.js';
import { FIELD_TYPES, RESTRICTABLE_ROLES, ROLLUP_FUNCTIONS, SQL_TYPE, VIEW_TYPES, isFilterGroup } from '../../../shared/src/index.js';
import { dataColumnName, dataTableName, getDb, linkTableName, newId, now, q } from '../db/index.js';
import { badRequest, notFound } from '../errors.js';
import { asText, newChoice, toStored } from '../data/codec.js';
import { FormulaError, displayFormula, normalizeFormula } from '../data/formula.js';
import { QueryContext, colExpr, compileFilter, compileSorts } from '../data/query.js';
import { selectColumnValues } from '../data/records.js';
import {
  type BaseRow,
  type ColumnMeta,
  baseRow,
  findColumn,
  findView,
  linkInfo,
  loadColumn,
  loadColumns,
  loadViewRows,
  tableRow,
  toBase,
  toColumnMeta,
} from './store.js';

const PRIMARY_INELIGIBLE: FieldType[] = ['Links', 'Attachment', 'JSON', 'Checkbox', 'Lookup'];
const SYSTEM_TYPES: FieldType[] = ['ID', 'CreatedTime', 'LastModifiedTime'];

const tx = <T>(fn: () => T): T => getDb().transaction(fn)();
const nextOrder = (table: string, where: string, arg: string) =>
  ((getDb().prepare(`SELECT MAX("order") AS m FROM ${table} WHERE ${where} = ?`).get(arg) as { m: number | null }).m ?? 0) + 1;
const isStoredType = (t: FieldType) => SQL_TYPE[t] !== undefined;

function cleanTitle(title: unknown, what: string): string {
  if (typeof title !== 'string' || !title.trim()) throw badRequest(`${what} title is required`);
  const t = title.trim();
  if (t.length > 255) throw badRequest(`${what} title is too long`);
  return t;
}

/** Strip server-only option keys and render formulas with current titles. */
function publicColumn(col: ColumnMeta, titleOf: (id: string) => string | undefined): Column {
  const options: ColumnOptions = {};
  for (const [k, v] of Object.entries(col.options)) if (!k.startsWith('_')) (options as Record<string, unknown>)[k] = v;
  if (col.type === 'Formula' && options.formula) options.formula = displayFormula(options.formula, titleOf);
  return { ...col, options, system: !!col.options._system };
}

function publicColumns(cols: ColumnMeta[]): Column[] {
  const titles = new Map(cols.map((c) => [c.id, c.title]));
  return cols.map((c) => publicColumn(c, (id) => titles.get(id)));
}

// ---------------------------------------------------------------------------------------------------------------
// Bases

export function listBases(userId: string): Base[] {
  const rows = getDb()
    .prepare(
      `SELECT b.*, m.role FROM nc_bases b JOIN nc_base_members m ON m.base_id = b.id WHERE m.user_id = ? ORDER BY b."order", b.created_at`,
    )
    .all(userId) as (BaseRow & { role: Base['role'] })[];
  return rows.map((r) => ({ ...toBase(r), role: r.role }));
}

export function createBase(userId: string, input: { title: string; description?: string | null; color?: string | null }): Base {
  const title = cleanTitle(input.title, 'Base');
  const row: BaseRow = {
    id: newId('base'),
    title,
    description: input.description ?? null,
    color: input.color ?? null,
    order: 0,
    created_at: now(),
  };
  tx(() => {
    row.order = ((getDb().prepare('SELECT MAX("order") AS m FROM nc_bases').get() as { m: number | null }).m ?? 0) + 1;
    getDb()
      .prepare('INSERT INTO nc_bases (id, title, description, color, "order", created_at) VALUES (@id, @title, @description, @color, @order, @created_at)')
      .run(row);
    getDb().prepare(`INSERT INTO nc_base_members (base_id, user_id, role) VALUES (?, ?, 'owner')`).run(row.id, userId);
  });
  return { ...toBase(row), role: 'owner' };
}

export function getBase(baseId: string): Base & { tables: Table[] } {
  return { ...toBase(baseRow(baseId)), tables: listTables(baseId) };
}

export function updateBase(baseId: string, patch: { title?: string; description?: string | null; color?: string | null; order?: number }): Base {
  const cur = baseRow(baseId);
  const next = {
    ...cur,
    title: patch.title !== undefined ? cleanTitle(patch.title, 'Base') : cur.title,
    description: patch.description !== undefined ? patch.description : cur.description,
    color: patch.color !== undefined ? patch.color : cur.color,
    order: patch.order ?? cur.order,
  };
  getDb().prepare('UPDATE nc_bases SET title = @title, description = @description, color = @color, "order" = @order WHERE id = @id').run(next);
  return toBase(next);
}

export function deleteBase(baseId: string): void {
  baseRow(baseId);
  tx(() => {
    const tables = getDb().prepare('SELECT id FROM nc_tables WHERE base_id = ?').all(baseId) as { id: string }[];
    for (const t of tables) dropPhysical(t.id);
    getDb().prepare('DELETE FROM nc_bases WHERE id = ?').run(baseId);
  });
}

/** Drop a table's data table and the junctions owned by its Links columns. */
function dropPhysical(tableId: string) {
  for (const c of loadColumns(tableId)) if (c.type === 'Links') getDb().exec(`DROP TABLE IF EXISTS ${q(linkInfo(c).junction)}`);
  getDb().exec(`DROP TABLE IF EXISTS ${q(dataTableName(tableId))}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Tables

export function listTables(baseId: string): Table[] {
  const rows = getDb().prepare('SELECT id FROM nc_tables WHERE base_id = ? ORDER BY "order", created_at').all(baseId) as { id: string }[];
  return rows.map((r) => getTable(r.id));
}

export function getTable(tableId: string): Table {
  const r = tableRow(tableId);
  const cols = loadColumns(tableId);
  return {
    id: r.id,
    baseId: r.base_id,
    title: r.title,
    description: r.description,
    order: r.order,
    columns: publicColumns(cols),
    views: loadViewRows(tableId).map((v) => reconcileView(v, cols)),
  };
}

function assertTableTitleFree(baseId: string, title: string, exceptId?: string) {
  const clash = getDb()
    .prepare('SELECT id FROM nc_tables WHERE base_id = ? AND lower(title) = lower(?) AND id != ?')
    .get(baseId, title, exceptId ?? '');
  if (clash) throw badRequest(`A table named "${title}" already exists in this base`);
}

export function createTable(baseId: string, input: { title: string; description?: string | null; columns?: ColumnInput[] }): Table {
  baseRow(baseId);
  const title = cleanTitle(input.title, 'Table');
  const inputs = input.columns ?? [];
  if (!Array.isArray(inputs)) throw badRequest('columns must be an array');
  const id = newId('tbl');
  tx(() => {
    assertTableTitleFree(baseId, title);
    const ts = now();
    getDb()
      .prepare('INSERT INTO nc_tables (id, base_id, title, description, "order", created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, baseId, title, input.description ?? null, nextOrder('nc_tables', 'base_id', baseId), ts);
    getDb().exec(
      `CREATE TABLE ${q(dataTableName(id))} (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`,
    );
    insertColumnRow({ tableId: id, title: 'ID', type: 'ID', options: { _system: true } });

    // Primary: an explicitly flagged column, else the first eligible stored column, else a new "Title".
    const userCols = inputs.filter((c) => c && !SYSTEM_TYPES.includes(c.type));
    let primaryIdx = userCols.findIndex((c) => c.primary);
    if (primaryIdx < 0) primaryIdx = userCols.findIndex((c) => isStoredType(c.type) && !PRIMARY_INELIGIBLE.includes(c.type));
    if (primaryIdx < 0) insertStoredColumn(id, { title: 'Title', type: 'SingleLineText', primary: true });

    // Stored columns first so formulas/lookups added afterwards can reference them.
    const ordered = userCols.map((c, i) => ({ c: { ...c, primary: i === primaryIdx }, i }));
    const created: { col: ColumnMeta; i: number }[] = [];
    for (const { c, i } of ordered) {
      if (c.type === 'Formula' || c.type === 'Lookup' || c.type === 'Rollup') continue;
      created.push({ col: addColumnTx(id, c, { appendToViews: false }), i });
    }
    for (const { c, i } of ordered) {
      if (c.type !== 'Formula' && c.type !== 'Lookup' && c.type !== 'Rollup') continue;
      created.push({ col: addColumnTx(id, c, { appendToViews: false }), i });
    }
    // Keep the caller's column order.
    created.sort((a, b) => a.i - b.i);
    created.forEach(({ col }, k) => getDb().prepare('UPDATE nc_columns SET "order" = ? WHERE id = ?').run(10 + k, col.id));

    insertColumnRow({ tableId: id, title: uniqueTitle(id, 'CreatedAt'), type: 'CreatedTime', options: { _system: true }, order: 100000 });
    insertColumnRow({ tableId: id, title: uniqueTitle(id, 'UpdatedAt'), type: 'LastModifiedTime', options: { _system: true }, order: 100001 });
    insertView(id, 'Default view', 'grid');
  });
  return getTable(id);
}

export function updateTable(tableId: string, patch: { title?: string; description?: string | null; order?: number }): Table {
  const cur = tableRow(tableId);
  const title = patch.title !== undefined ? cleanTitle(patch.title, 'Table') : cur.title;
  if (title !== cur.title) assertTableTitleFree(cur.base_id, title, tableId);
  getDb()
    .prepare('UPDATE nc_tables SET title = ?, description = ?, "order" = ? WHERE id = ?')
    .run(title, patch.description !== undefined ? patch.description : cur.description, patch.order ?? cur.order, tableId);
  return getTable(tableId);
}

export function deleteTable(tableId: string): void {
  tableRow(tableId);
  tx(() => {
    const seen = new Set<string>();
    for (const c of loadColumns(tableId)) {
      seen.add(c.id);
      if (c.type !== 'Links') continue;
      const sym = c.options.symmetricColumnId ? findColumn(c.options.symmetricColumnId) : null;
      if (sym && sym.tableId !== tableId) removeColumn(sym, seen);
    }
    // Lookups/rollups elsewhere that target this table's columns through other paths
    for (const c of loadColumns(tableId)) for (const dep of dependents(c.id)) if (dep.tableId !== tableId) removeColumn(dep, seen);
    dropPhysical(tableId);
    getDb().prepare('DELETE FROM nc_tables WHERE id = ?').run(tableId);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Columns

interface ColumnRowInput {
  id?: string;
  tableId: string;
  title: string;
  type: FieldType;
  options?: ColumnMeta['options'];
  required?: boolean;
  defaultValue?: unknown;
  description?: string | null;
  primary?: boolean;
  order?: number;
}

function insertColumnRow(c: ColumnRowInput): ColumnMeta {
  const id = c.id ?? newId('col');
  getDb()
    .prepare(
      `INSERT INTO nc_columns (id, table_id, title, type, is_primary, required, default_value, description, options, "order", created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      c.tableId,
      c.title,
      c.type,
      c.primary ? 1 : 0,
      c.required ? 1 : 0,
      c.defaultValue === undefined || c.defaultValue === null ? null : JSON.stringify(c.defaultValue),
      c.description ?? null,
      JSON.stringify(c.options ?? {}),
      c.order ?? nextOrder('nc_columns', 'table_id', c.tableId),
      now(),
    );
  return loadColumn(id);
}

function saveColumn(c: ColumnMeta) {
  getDb()
    .prepare(
      `UPDATE nc_columns SET title = ?, type = ?, is_primary = ?, required = ?, default_value = ?, description = ?, options = ? WHERE id = ?`,
    )
    .run(
      c.title,
      c.type,
      c.primary ? 1 : 0,
      c.required ? 1 : 0,
      c.defaultValue === undefined || c.defaultValue === null ? null : JSON.stringify(c.defaultValue),
      c.description ?? null,
      JSON.stringify(c.options),
      c.id,
    );
}

function titleTaken(tableId: string, title: string, exceptId?: string) {
  return !!getDb()
    .prepare('SELECT 1 FROM nc_columns WHERE table_id = ? AND lower(title) = lower(?) AND id != ?')
    .get(tableId, title, exceptId ?? '');
}

function uniqueTitle(tableId: string, base: string): string {
  let t = base;
  for (let n = 2; titleTaken(tableId, t); n++) t = `${base} (${n})`;
  return t;
}

/** Validate and normalise type-specific options. */
function prepareOptions(tableId: string, type: FieldType, input: ColumnOptions | undefined, prev?: ColumnMeta): ColumnMeta['options'] {
  const o: ColumnMeta['options'] = { ...(prev?.type === type ? prev.options : {}), ...(input ?? {}) };
  // Keep only internal keys from the previous definition, never from client input.
  for (const k of ['_jt', '_side', '_system'] as const) {
    if (prev?.type === type && prev.options[k] !== undefined) (o as Record<string, unknown>)[k] = prev.options[k];
    else delete o[k];
  }
  // Field permissions survive type changes unless the patch sets them.
  if (input?.permissions === undefined && prev?.options.permissions) o.permissions = prev.options.permissions;
  normalizePermissions(o);
  switch (type) {
    case 'SingleSelect':
    case 'MultiSelect': {
      const seen = new Set<string>();
      const choices: SelectOption[] = [];
      for (const ch of o.choices ?? []) {
        const title = typeof ch === 'string' ? ch : ch?.title;
        if (typeof title !== 'string' || !title.trim()) continue;
        const t = title.trim();
        if (seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        const base = newChoice(t, choices.length);
        choices.push({
          id: typeof ch === 'object' && ch.id ? ch.id : base.id,
          title: t,
          color: typeof ch === 'object' && ch.color ? ch.color : base.color,
        });
      }
      o.choices = choices;
      break;
    }
    case 'Rating':
      o.max = Math.min(10, Math.max(1, Math.round(Number(o.max ?? 5)) || 5));
      break;
    case 'Currency':
      o.currencyCode ??= 'USD';
      break;
    case 'Links': {
      if (!o.relatedTableId) throw badRequest('Links fields need options.relatedTableId');
      const related = getDb().prepare('SELECT base_id FROM nc_tables WHERE id = ?').get(o.relatedTableId) as { base_id: string } | undefined;
      if (!related || related.base_id !== tableRow(tableId).base_id) throw badRequest('Related table not found in this base');
      o.relation ??= 'mm';
      if (!['mm', 'hm', 'bt'].includes(o.relation)) throw badRequest(`Unknown relation ${o.relation}`);
      break;
    }
    case 'Lookup':
    case 'Rollup': {
      const link = o.linkColumnId ? findColumn(o.linkColumnId) : null;
      if (!link || link.tableId !== tableId || link.type !== 'Links') throw badRequest(`${type} fields need options.linkColumnId (a Links field of this table)`);
      if (type === 'Rollup') {
        o.rollupFunction ??= 'count';
        if (!ROLLUP_FUNCTIONS.includes(o.rollupFunction)) throw badRequest(`Unknown rollup function ${o.rollupFunction}`);
      }
      if (type === 'Lookup' || o.rollupFunction !== 'count' || o.targetColumnId) {
        const target = o.targetColumnId ? findColumn(o.targetColumnId) : null;
        if (!target || target.tableId !== link.options.relatedTableId)
          throw badRequest(`${type} fields need options.targetColumnId (a field of the linked table)`);
      }
      break;
    }
    case 'Formula': {
      if (typeof o.formula !== 'string' || !o.formula.trim()) throw badRequest('Formula fields need options.formula');
      // A formula from a previous save is already normalized (ids); one from the client uses titles.
      if (input?.formula !== undefined) {
        try {
          o.formula = normalizeFormula(o.formula, loadColumns(tableId)).normalized;
        } catch (e) {
          if (e instanceof FormulaError) throw badRequest(`Invalid formula: ${e.message}`);
          throw e;
        }
      }
      break;
    }
  }
  return o;
}

/** Validate `options.permissions`: role lists without owner, duplicates or unknown roles; empty → removed. */
function normalizePermissions(o: ColumnMeta['options']) {
  const p = o.permissions as unknown;
  if (p === undefined) return;
  if (p === null) {
    delete o.permissions;
    return;
  }
  if (typeof p !== 'object' || Array.isArray(p)) throw badRequest('options.permissions must be an object');
  const list = (v: unknown, key: string) => {
    if (v == null) return [];
    if (!Array.isArray(v)) throw badRequest(`options.permissions.${key} must be an array of roles`);
    for (const r of v) if (!RESTRICTABLE_ROLES.includes(r)) throw badRequest(`options.permissions.${key}: unknown or unrestrictable role ${JSON.stringify(r)}`);
    return RESTRICTABLE_ROLES.filter((r) => v.includes(r));
  };
  const { hiddenFor, readOnlyFor } = p as { hiddenFor?: unknown; readOnlyFor?: unknown };
  const h = list(hiddenFor, 'hiddenFor');
  const r = list(readOnlyFor, 'readOnlyFor').filter((x) => !h.includes(x));
  if (!h.length && !r.length) delete o.permissions;
  else o.permissions = { ...(h.length ? { hiddenFor: h } : {}), ...(r.length ? { readOnlyFor: r } : {}) };
}

/** Compile a virtual column once in strict mode so bad formulas and circular references fail on save. */
function validateVirtual(col: ColumnMeta) {
  if (!['Formula', 'Lookup', 'Rollup'].includes(col.type)) return;
  const qc = new QueryContext(true);
  qc.put(col);
  try {
    const expr = colExpr(qc, col, 't');
    getDb()
      .prepare(`SELECT ${expr.sql} FROM ${q(dataTableName(col.tableId))} t LIMIT 0`)
      .all(...expr.params);
  } catch (e) {
    if (e instanceof FormulaError) throw badRequest(col.type === 'Formula' ? `Invalid formula: ${e.message}` : e.message);
    if (e instanceof Error && /SQLITE|sqlite|no such|syntax/i.test(`${(e as { code?: string }).code ?? ''} ${e.message}`))
      throw badRequest(`Invalid ${col.type.toLowerCase()}: ${e.message}`);
    throw e;
  }
}

function validateDefault(col: ColumnMeta) {
  if (col.defaultValue === undefined || col.defaultValue === null) return;
  if (!isStoredType(col.type)) throw badRequest(`${col.type} fields cannot have a default value`);
  toStored(col, col.defaultValue, { strict: true });
}

function checkPrimary(type: FieldType, primary: boolean | undefined) {
  if (primary && (PRIMARY_INELIGIBLE.includes(type) || SYSTEM_TYPES.includes(type))) throw badRequest(`A ${type} field cannot be the primary field`);
}

function setPrimary(tableId: string, columnId: string) {
  getDb().prepare('UPDATE nc_columns SET is_primary = (id = ?) WHERE table_id = ?').run(columnId, tableId);
}

function addPhysical(tableId: string, columnId: string, type: FieldType, name = dataColumnName(columnId)) {
  getDb().exec(`ALTER TABLE ${q(dataTableName(tableId))} ADD COLUMN ${q(name)} ${SQL_TYPE[type]}`);
}

function dropPhysicalColumn(tableId: string, columnId: string) {
  getDb().exec(`ALTER TABLE ${q(dataTableName(tableId))} DROP COLUMN ${q(dataColumnName(columnId))}`);
}

function insertStoredColumn(tableId: string, input: ColumnInput): ColumnMeta {
  const col = insertColumnRow({ tableId, title: input.title, type: input.type, primary: input.primary, options: prepareOptions(tableId, input.type, input.options) });
  addPhysical(tableId, col.id, col.type);
  return col;
}

const inverseRelation = (r: ColumnOptions['relation']): ColumnOptions['relation'] => (r === 'hm' ? 'bt' : r === 'bt' ? 'hm' : 'mm');

/** Create the junction table and the symmetric column for a (new) Links column. */
function setupLinks(col: ColumnMeta) {
  const jt = linkTableName(col.id);
  getDb().exec(
    `CREATE TABLE ${q(jt)} (id INTEGER PRIMARY KEY, a_id INTEGER NOT NULL, b_id INTEGER NOT NULL, UNIQUE (a_id, b_id));
     CREATE INDEX ${q(`${jt}_b`)} ON ${q(jt)} (b_id);`,
  );
  const relatedId = col.options.relatedTableId!;
  const symId = newId('col');
  const sym = insertColumnRow({
    id: symId,
    tableId: relatedId,
    title: uniqueTitle(relatedId, tableRow(col.tableId).title),
    type: 'Links',
    options: { relatedTableId: col.tableId, relation: inverseRelation(col.options.relation), symmetricColumnId: col.id, _jt: col.id, _side: 'b' },
  });
  col.options = { ...col.options, symmetricColumnId: sym.id, _jt: col.id, _side: 'a' };
  saveColumn(col);
  appendColumnToViews(sym);
}

/** Drop a Links column's junction, its symmetric column and everything depending on either. */
function teardownLinks(col: ColumnMeta, seen: Set<string>) {
  seen.add(col.id);
  for (const dep of dependents(col.id)) removeColumn(dep, seen);
  const sym = col.options.symmetricColumnId ? findColumn(col.options.symmetricColumnId) : null;
  if (sym && !seen.has(sym.id)) removeColumn(sym, seen);
  getDb().exec(`DROP TABLE IF EXISTS ${q(linkInfo(col).junction)}`);
}

/** Lookup/Rollup columns that use `columnId` as link or target. */
function dependents(columnId: string): ColumnMeta[] {
  const rows = getDb()
    .prepare(
      `SELECT id FROM nc_columns WHERE type IN ('Lookup','Rollup') AND (json_extract(options, '$.linkColumnId') = ? OR json_extract(options, '$.targetColumnId') = ?)`,
    )
    .all(columnId, columnId) as { id: string }[];
  return rows.map((r) => loadColumn(r.id));
}

function removeColumn(col: ColumnMeta, seen: Set<string>) {
  if (!findColumn(col.id)) return;
  seen.add(col.id);
  for (const dep of dependents(col.id)) if (!seen.has(dep.id)) removeColumn(dep, seen);
  if (col.type === 'Links') teardownLinks(col, seen);
  if (isStoredType(col.type)) {
    const exists = getDb().prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(dataTableName(col.tableId), dataColumnName(col.id));
    if (exists) dropPhysicalColumn(col.tableId, col.id);
  }
  getDb().prepare('DELETE FROM nc_columns WHERE id = ?').run(col.id);
  removeColumnFromViews(col.tableId, col.id);
}

function addColumnTx(tableId: string, input: ColumnInput, opts: { appendToViews: boolean }): ColumnMeta {
  if (!input || typeof input !== 'object') throw badRequest('Column definition must be an object');
  const title = cleanTitle(input.title, 'Field');
  if (!FIELD_TYPES.includes(input.type)) throw badRequest(`Unknown field type ${String(input.type)}`);
  if (input.type === 'ID') throw badRequest('A table has exactly one ID field');
  if (titleTaken(tableId, title)) throw badRequest(`A field named "${title}" already exists in this table`);
  checkPrimary(input.type, input.primary);
  const id = newId('col');
  const options = prepareOptions(tableId, input.type, input.options);
  const col = insertColumnRow({
    id,
    tableId,
    title,
    type: input.type,
    options,
    required: !!input.required,
    defaultValue: input.defaultValue,
    description: input.description ?? null,
    primary: !!input.primary,
  });
  validateDefault(col);
  if (col.defaultValue !== undefined) saveColumn(col); // default may have added a select choice
  if (input.primary) setPrimary(tableId, id);
  if (isStoredType(col.type)) addPhysical(tableId, id, col.type);
  if (col.type === 'Links') setupLinks(col);
  validateVirtual(col);
  if (opts.appendToViews) appendColumnToViews(col);
  return loadColumn(id);
}

function columnOut(col: ColumnMeta): Column {
  const cols = loadColumns(col.tableId);
  const titles = new Map(cols.map((c) => [c.id, c.title]));
  return publicColumn(loadColumn(col.id), (id) => titles.get(id));
}

export function addColumn(tableId: string, input: ColumnInput): Column {
  tableRow(tableId);
  return columnOut(tx(() => addColumnTx(tableId, input, { appendToViews: true })));
}

export function getColumn(columnId: string): Column {
  return columnOut(loadColumn(columnId));
}

export function updateColumn(columnId: string, patch: Partial<ColumnInput>): Column {
  const updated = tx(() => {
    const old = loadColumn(columnId);
    const type = patch.type ?? old.type;
    if (!FIELD_TYPES.includes(type)) throw badRequest(`Unknown field type ${String(type)}`);
    if (type !== old.type && (old.system || SYSTEM_TYPES.includes(type) || old.type === 'ID'))
      throw badRequest('System fields cannot change type, and fields cannot become system fields');
    const title = patch.title !== undefined ? cleanTitle(patch.title, 'Field') : old.title;
    if (title.toLowerCase() !== old.title.toLowerCase() && titleTaken(old.tableId, title, old.id))
      throw badRequest(`A field named "${title}" already exists in this table`);
    if (patch.primary === false && old.primary) throw badRequest('Set another field as primary instead');
    const primary = patch.primary ?? old.primary;
    checkPrimary(type, primary);

    if (type === 'Links' && old.type === 'Links' && patch.options?.relatedTableId && patch.options.relatedTableId !== old.options.relatedTableId)
      throw badRequest('The related table of a Links field cannot be changed; create a new Links field instead');

    let options = prepareOptions(old.tableId, type, patch.options, old);
    const next: ColumnMeta = {
      ...old,
      title,
      type,
      primary,
      options,
      required: patch.required ?? old.required,
      defaultValue: patch.defaultValue !== undefined ? patch.defaultValue : old.defaultValue,
      description: patch.description !== undefined ? patch.description : old.description,
    };
    if (type !== old.type && patch.defaultValue === undefined) next.defaultValue = undefined;
    validateDefault(next);

    if (type === old.type) {
      if ((type === 'SingleSelect' || type === 'MultiSelect') && patch.options?.choices) renameChoices(old, next);
      if (type === 'Links' && next.options.relation !== old.options.relation) {
        const sym = old.options.symmetricColumnId ? findColumn(old.options.symmetricColumnId) : null;
        if (sym) {
          sym.options.relation = inverseRelation(next.options.relation);
          saveColumn(sym);
        }
      }
      saveColumn(next);
    } else {
      convertType(old, next);
    }
    if (primary && !old.primary) setPrimary(old.tableId, old.id);
    validateVirtual(loadColumn(columnId));
    return loadColumn(columnId);
  });
  return columnOut(updated);
}

/** Choice renames (matched by option id) are applied to the stored data. */
function renameChoices(old: ColumnMeta, next: ColumnMeta) {
  const prev = new Map((old.options.choices ?? []).filter((c) => c.id).map((c) => [c.id!, c.title]));
  const T = q(dataTableName(old.tableId));
  const C = q(dataColumnName(old.id));
  for (const ch of next.options.choices ?? []) {
    const before = ch.id ? prev.get(ch.id) : undefined;
    if (before === undefined || before === ch.title) continue;
    if (old.type === 'SingleSelect') getDb().prepare(`UPDATE ${T} SET ${C} = ? WHERE ${C} = ?`).run(ch.title, before);
    else
      getDb()
        .prepare(
          `UPDATE ${T} SET ${C} = (SELECT json_group_array(CASE WHEN value = ? THEN ? ELSE value END) FROM json_each(${C}))
           WHERE EXISTS (SELECT 1 FROM json_each(${C}) WHERE value = ?)`,
        )
        .run(before, ch.title, before);
  }
}

/** Change a column's type, converting existing data best-effort (invalid values become empty). */
function convertType(old: ColumnMeta, next: ColumnMeta) {
  const oldStored = isStoredType(old.type);
  const newStored = isStoredType(next.type);
  // Read the current values before any teardown.
  const values = newStored ? selectColumnValues(old.tableId, old, true) : [];
  if (old.type === 'Links') {
    const seen = new Set<string>();
    teardownLinks(old, seen);
    next.options = { ...next.options };
    delete next.options._jt;
    delete next.options._side;
    delete next.options.symmetricColumnId;
  }
  saveColumn(next);
  if (next.type === 'Links') setupLinks(next);
  if (newStored) {
    const tmp = `${dataColumnName(old.id)}__new`;
    addPhysical(old.tableId, old.id, next.type, tmp);
    const dirty = { v: false };
    const stmt = getDb().prepare(`UPDATE ${q(dataTableName(old.tableId))} SET ${q(tmp)} = ? WHERE id = ?`);
    for (const { id, value: rawValue } of values) {
      // Links come as [{id, display}]: convert by display value.
      const value = Array.isArray(rawValue)
        ? rawValue.map((x) => (x && typeof x === 'object' && 'display' in x ? (x as { display: unknown }).display : x))
        : rawValue;
      const v =
        Array.isArray(value) && !['MultiSelect', 'SingleSelect', 'Attachment', 'JSON'].includes(next.type) ? asText(value) : value;
      const stored = toStored(next, v, { strict: false, onNewChoice: () => (dirty.v = true) });
      if (stored !== null) stmt.run(stored, id);
    }
    if (dirty.v) saveColumn(next);
    if (oldStored) dropPhysicalColumn(old.tableId, old.id);
    getDb().exec(`ALTER TABLE ${q(dataTableName(old.tableId))} RENAME COLUMN ${q(tmp)} TO ${q(dataColumnName(old.id))}`);
  } else if (oldStored) {
    dropPhysicalColumn(old.tableId, old.id);
  }
}

export function deleteColumn(columnId: string): void {
  const col = loadColumn(columnId);
  if (col.type === 'ID' || col.system) throw badRequest('System fields cannot be deleted');
  if (col.primary) throw badRequest('The primary field cannot be deleted; make another field primary first');
  tx(() => removeColumn(col, new Set()));
}

// ---------------------------------------------------------------------------------------------------------------
// Views

const defaultShow = (c: ColumnMeta) => !(c.system && (c.type === 'CreatedTime' || c.type === 'LastModifiedTime'));

/** Make a view's column list match the table: drop deleted columns, append new ones. */
function reconcileView(view: View, cols: ColumnMeta[]): View {
  const ids = new Set(cols.map((c) => c.id));
  const kept = view.columns.filter((vc) => ids.has(vc.columnId)).sort((a, b) => a.order - b.order);
  const have = new Set(kept.map((k) => k.columnId));
  let order = kept.reduce((m, k) => Math.max(m, k.order), 0);
  for (const c of cols) if (!have.has(c.id)) kept.push({ columnId: c.id, show: defaultShow(c), order: ++order });
  return { ...view, columns: kept };
}

function defaultMeta(type: ViewType, cols: ColumnMeta[], meta: ViewMeta = {}, creating = false): ViewMeta {
  const m = { ...meta };
  const valid = (id?: string) => !!id && cols.some((c) => c.id === id);
  if (type === 'kanban' && !valid(m.groupColumnId)) m.groupColumnId = cols.find((c) => c.type === 'SingleSelect')?.id;
  const dates = cols.filter((c) => c.type === 'Date' || c.type === 'DateTime');
  if ((type === 'calendar' || type === 'timeline') && !valid(m.dateColumnId)) m.dateColumnId = dates[0]?.id;
  if (type === 'timeline' && creating && !valid(m.endDateColumnId)) m.endDateColumnId = dates.find((c) => c.id !== m.dateColumnId)?.id;
  if (type === 'timeline') m.timelineScale ??= 'week';
  if (type === 'map' && !valid(m.geoColumnId)) m.geoColumnId = cols.find((c) => c.type === 'GeoData')?.id;
  if ((type === 'gallery' || type === 'kanban') && !valid(m.coverColumnId)) m.coverColumnId = cols.find((c) => c.type === 'Attachment')?.id;
  for (const k of Object.keys(m) as (keyof ViewMeta)[]) if (m[k] === undefined) delete m[k];
  return m;
}

function insertView(tableId: string, title: string, type: ViewType, from?: View): View {
  const cols = loadColumns(tableId);
  const id = newId('vw');
  const columns: ViewColumn[] = from
    ? reconcileView(from, cols).columns
    : cols.map((c, i) => ({ columnId: c.id, show: defaultShow(c), order: i + 1 }));
  getDb()
    .prepare(
      `INSERT INTO nc_views (id, table_id, title, type, "order", locked, filter, sorts, columns, meta, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tableId,
      title,
      type,
      nextOrder('nc_views', 'table_id', tableId),
      from?.filter ? JSON.stringify(from.filter) : null,
      JSON.stringify(from?.sorts ?? []),
      JSON.stringify(columns),
      JSON.stringify(defaultMeta(type, cols, from?.meta, true)),
      now(),
    );
  return getView(id);
}

export function getView(viewId: string): View {
  const v = findView(viewId);
  if (!v) throw notFound('View');
  return reconcileView(v, loadColumns(v.tableId));
}

function assertViewTitleFree(tableId: string, title: string, exceptId?: string) {
  if (getDb().prepare('SELECT 1 FROM nc_views WHERE table_id = ? AND lower(title) = lower(?) AND id != ?').get(tableId, title, exceptId ?? ''))
    throw badRequest(`A view named "${title}" already exists for this table`);
}

export function createView(tableId: string, input: { title: string; type: ViewType; copyFromViewId?: string }): View {
  tableRow(tableId);
  const title = cleanTitle(input.title, 'View');
  if (!VIEW_TYPES.includes(input.type)) throw badRequest(`Unknown view type ${String(input.type)}`);
  return tx(() => {
    assertViewTitleFree(tableId, title);
    let from: View | undefined;
    if (input.copyFromViewId) {
      const src = findView(input.copyFromViewId);
      if (!src || src.tableId !== tableId) throw badRequest('copyFromViewId must be a view of the same table');
      from = src;
    }
    return insertView(tableId, title, input.type, from);
  });
}

export interface ViewPatch {
  title?: string;
  order?: number;
  locked?: boolean;
  filter?: FilterGroup | null;
  sorts?: Sort[];
  columns?: ViewColumn[];
  meta?: ViewMeta;
}

export function updateView(viewId: string, patch: ViewPatch): View {
  const cur = getView(viewId);
  const cols = loadColumns(cur.tableId);
  const next: View = { ...cur };
  if (patch.title !== undefined) {
    next.title = cleanTitle(patch.title, 'View');
    if (next.title.toLowerCase() !== cur.title.toLowerCase()) assertViewTitleFree(cur.tableId, next.title, viewId);
  }
  if (patch.order !== undefined) next.order = patch.order;
  if (patch.locked !== undefined) next.locked = patch.locked;
  const qc = new QueryContext();
  if (patch.filter !== undefined) {
    if (patch.filter) compileFilter(qc, patch.filter, cur.tableId, 't', true);
    next.filter = patch.filter ?? null;
  }
  if (patch.sorts !== undefined) {
    compileSorts(qc, patch.sorts, cur.tableId, 't', true);
    next.sorts = patch.sorts;
  }
  if (patch.columns !== undefined) {
    const ids = new Set(cols.map((c) => c.id));
    const bad = patch.columns.find((c) => !ids.has(c.columnId));
    if (bad) throw badRequest(`Unknown field ${bad.columnId}`);
    // Columns not mentioned keep their previous settings.
    const given = new Map(patch.columns.map((c) => [c.columnId, c]));
    next.columns = reconcileView(
      { ...cur, columns: [...patch.columns, ...cur.columns.filter((c) => !given.has(c.columnId))] },
      cols,
    ).columns;
  }
  if (patch.meta !== undefined) {
    next.meta = { ...cur.meta, ...patch.meta };
    for (const k of Object.keys(next.meta) as (keyof ViewMeta)[]) if (next.meta[k] === null) delete next.meta[k];
  }
  getDb()
    .prepare('UPDATE nc_views SET title = ?, "order" = ?, locked = ?, filter = ?, sorts = ?, columns = ?, meta = ? WHERE id = ?')
    .run(
      next.title,
      next.order,
      next.locked ? 1 : 0,
      next.filter ? JSON.stringify(next.filter) : null,
      JSON.stringify(next.sorts),
      JSON.stringify(next.columns),
      JSON.stringify(next.meta),
      viewId,
    );
  return getView(viewId);
}

export function deleteView(viewId: string): void {
  const v = getView(viewId);
  const n = (getDb().prepare('SELECT COUNT(*) AS n FROM nc_views WHERE table_id = ?').get(v.tableId) as { n: number }).n;
  if (n <= 1) throw badRequest('The last view of a table cannot be deleted');
  getDb().prepare('DELETE FROM nc_views WHERE id = ?').run(viewId);
}

function appendColumnToViews(col: ColumnMeta) {
  for (const v of loadViewRows(col.tableId)) {
    if (v.columns.some((c) => c.columnId === col.id)) continue;
    const order = v.columns.reduce((m, c) => Math.max(m, c.order), 0) + 1;
    const columns = [...v.columns, { columnId: col.id, show: defaultShow(col), order }];
    const meta = defaultMeta(v.type, loadColumns(col.tableId), v.meta);
    getDb().prepare('UPDATE nc_views SET columns = ?, meta = ? WHERE id = ?').run(JSON.stringify(columns), JSON.stringify(meta), v.id);
  }
}

function stripFilter(g: FilterGroup, columnId: string): FilterGroup {
  return {
    ...g,
    children: g.children
      .map((c) => (isFilterGroup(c) ? stripFilter(c, columnId) : c))
      .filter((c) => (isFilterGroup(c) ? true : c.columnId !== columnId)),
  };
}

function removeColumnFromViews(tableId: string, columnId: string) {
  for (const v of loadViewRows(tableId)) {
    const meta: ViewMeta = { ...v.meta };
    for (const k of ['groupColumnId', 'coverColumnId', 'dateColumnId', 'endDateColumnId', 'geoColumnId'] as const) if (meta[k] === columnId) delete meta[k];
    if (meta.groupBy) meta.groupBy = meta.groupBy.filter((s) => s.columnId !== columnId);
    getDb()
      .prepare('UPDATE nc_views SET columns = ?, filter = ?, sorts = ?, meta = ? WHERE id = ?')
      .run(
        JSON.stringify(v.columns.filter((c) => c.columnId !== columnId)),
        v.filter ? JSON.stringify(stripFilter(v.filter, columnId)) : null,
        JSON.stringify(v.sorts.filter((s) => s.columnId !== columnId)),
        JSON.stringify(defaultMeta(v.type, loadColumns(tableId).filter((c) => c.id !== columnId), meta)),
        v.id,
      );
  }
}

/** Re-exported for routes / other modules that need raw column metadata. */
export { loadColumns, toColumnMeta };
