import ExcelJS from 'exceljs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import Papa from 'papaparse';
import type { Column, FieldType, Table } from '../../../shared/src/index.js';
import { isReadOnlyType } from '../../../shared/src/index.js';
import { requireBaseRole, requireUser } from '../auth/plugin.js';
import type { Access } from '../data/access.js';
import { insertRecords } from '../data/records.js';
import { getDb } from '../db/index.js';
import { badRequest } from '../errors.js';
import { createTable, getTable } from '../meta/service.js';
import { audit, withoutRecordAudit } from './audit.js';
import { doc } from './docs.js';
import { MAX_UPLOAD_BYTES } from './files.js';
import { convertValue, dateText, inferType, type Inferred } from './infer.js';

export const IMPORT_BATCH = 500;
const SAMPLE_ROWS = 10;

export interface Sheet {
  name: string;
  headers: string[];
  rows: unknown[][];
}

type ColumnInput = Parameters<typeof createTable>[1] extends { columns?: (infer C)[] } ? C : never;

// ---------- parsing ----------

/** Non-empty, unique header titles. `id` would clash with the system ID field. */
export function normalizeHeaders(raw: unknown[]): string[] {
  const seen = new Set<string>();
  return raw.map((h, i) => {
    let base = (h == null ? '' : String(h)).replace(/\s+/g, ' ').trim().slice(0, 255) || `Field ${i + 1}`;
    if (/^id$/i.test(base)) base = `${base} (imported)`;
    let title = base;
    for (let n = 2; seen.has(title.toLowerCase()); n++) title = `${base} (${n})`;
    seen.add(title.toLowerCase());
    return title;
  });
}

function parseCsv(text: string, name: string): Sheet[] {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
  if (res.errors.length && !res.data.length) throw badRequest(`Could not parse CSV: ${res.errors[0].message}`);
  const [head = [], ...rows] = res.data;
  return [{ name, headers: normalizeHeaders(head), rows }];
}

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v !== 'object') return v;
  const o = v as unknown as Record<string, unknown>;
  if ('result' in o) return cellValue(o.result as ExcelJS.CellValue);
  if ('richText' in o) return (o.richText as { text: string }[]).map((r) => r.text).join('');
  if ('text' in o) return typeof o.text === 'string' ? o.text : cellValue(o.text as ExcelJS.CellValue);
  if ('hyperlink' in o) return o.hyperlink;
  if ('error' in o) return null;
  return JSON.stringify(o);
}

async function parseXlsx(buf: Buffer): Promise<Sheet[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw badRequest('Could not read the Excel file');
  }
  const sheets: Sheet[] = [];
  wb.eachSheet((ws) => {
    const width = ws.columnCount;
    const read = (r: ExcelJS.Row) => Array.from({ length: width }, (_, i) => cellValue(r.getCell(i + 1).value));
    const all: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => all.push(read(row)));
    if (!all.length) return;
    const [head, ...rows] = all;
    // Drop trailing columns with neither a header nor data.
    let w = head.length;
    while (w > 0 && head[w - 1] == null && rows.every((r) => r[w - 1] == null)) w--;
    sheets.push({ name: ws.name, headers: normalizeHeaders(head.slice(0, w)), rows: rows.map((r) => r.slice(0, w)) });
  });
  return sheets;
}

function parseJsonFile(text: string, name: string): Sheet[] {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw badRequest('Invalid JSON file');
  }
  if (data && !Array.isArray(data) && typeof data === 'object' && Array.isArray((data as { list?: unknown }).list)) data = (data as { list: unknown[] }).list;
  if (!Array.isArray(data) || data.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw badRequest('JSON must be an array of objects');
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of data as Record<string, unknown>[]) for (const k of Object.keys(r)) if (!seen.has(k)) seen.add(k), keys.push(k);
  const rows = (data as Record<string, unknown>[]).map((r) =>
    keys.map((k) => {
      const v = r[k];
      return v != null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : Array.isArray(v) && v.every((x) => typeof x !== 'object') ? v.join(', ') : v;
    }),
  );
  return [{ name, headers: normalizeHeaders(keys), rows }];
}

export async function parseUpload(filename: string, buf: Buffer): Promise<Sheet[]> {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const base = filename.replace(/\.[^.]+$/, '') || 'Imported';
  if (ext === 'xlsx' || ext === 'xlsm') return parseXlsx(buf);
  if (ext === 'json') return parseJsonFile(buf.toString('utf8'), base);
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return parseCsv(buf.toString('utf8'), base);
  throw badRequest('Unsupported file type (use .csv, .xlsx or .json)');
}

export function inferColumns(sheet: Sheet): Inferred[] {
  return sheet.headers.map((_, i) =>
    inferType(
      sheet.rows.map((r) => r[i]),
      i === 0,
    ),
  );
}

// ---------- multipart ----------

interface Upload {
  filename: string;
  buffer: Buffer;
  fields: Record<string, string>;
}

async function readUpload(req: FastifyRequest): Promise<Upload> {
  let file: { filename: string; buffer: Buffer } | null = null;
  const fields: Record<string, string> = {};
  for await (const part of req.parts({ limits: { fileSize: MAX_UPLOAD_BYTES } })) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (!file) file = { filename: part.filename || 'upload.csv', buffer };
    } else if (typeof part.value === 'string') {
      fields[part.fieldname] = part.value;
    }
  }
  if (!file) throw badRequest('Missing file');
  return { ...file, fields };
}

const previewValue = (v: unknown) => (v instanceof Date ? dateText(v) : v ?? null);

// ---------- import ----------

const SYSTEM: FieldType[] = ['ID', 'CreatedTime', 'LastModifiedTime'];

export interface ImportOptions {
  baseId: string;
  userId: string;
  filename: string;
  sheet: Sheet;
  tableId?: string;
  tableTitle?: string;
  columnMap?: Record<string, string>;
  /** Caller's role: when importing into an existing table, field permissions apply (403 on read-only fields). */
  access?: Access;
}

/** Import parsed rows into a new or existing table. Runs in one transaction. */
export function importSheet(opts: ImportOptions): { table: Table; inserted: number; skippedHeaders: string[] } {
  const { baseId, sheet } = opts;
  const db = getDb();
  return db.transaction(() => {
    let table: Table;
    let mapping: { index: number; column: Column }[];
    const skippedHeaders: string[] = [];
    let created = false;

    if (opts.tableId) {
      table = getTable(opts.tableId);
      if (table.baseId !== baseId) throw badRequest('Table does not belong to this base');
      const writable = table.columns.filter((c) => !isReadOnlyType(c.type));
      const byId = new Map(writable.map((c) => [c.id, c]));
      const byTitle = new Map(writable.map((c) => [c.title.toLowerCase(), c]));
      mapping = [];
      sheet.headers.forEach((h, index) => {
        const explicit = opts.columnMap?.[h];
        const column = explicit !== undefined ? (explicit ? byId.get(explicit) : undefined) : byTitle.get(h.toLowerCase().replace(/ \(imported\)$/, '')) ?? byTitle.get(h.toLowerCase());
        if (explicit && !column) throw badRequest(`columnMap: unknown or read-only column for "${h}"`);
        if (column) mapping.push({ index, column });
        else skippedHeaders.push(h);
      });
      if (!mapping.length) throw badRequest('No columns matched the file headers');
    } else {
      if (!sheet.headers.length) throw badRequest('The file has no header row');
      const inferred = inferColumns(sheet);
      const columns: ColumnInput[] = sheet.headers.map(
        (title, i) => ({ title, type: inferred[i].type, options: inferred[i].options ?? {}, primary: i === 0 }) as ColumnInput,
      );
      const title = (opts.tableTitle?.trim() || sheet.name || 'Imported').slice(0, 255);
      table = createTable(baseId, { title, columns });
      created = true;
      const userCols = table.columns.filter((c) => !SYSTEM.includes(c.type));
      const byTitle = new Map(userCols.map((c) => [c.title.toLowerCase(), c]));
      mapping = sheet.headers.flatMap((h, index) => {
        const column = byTitle.get(h.toLowerCase());
        return column ? [{ index, column }] : [];
      });
    }

    let inserted = 0;
    withoutRecordAudit(() => {
      for (let start = 0; start < sheet.rows.length; start += IMPORT_BATCH) {
        const batch = sheet.rows.slice(start, start + IMPORT_BATCH).map((r) => {
          const rec: Record<string, unknown> = {};
          for (const { index, column } of mapping) {
            const v = convertValue(column.type, r[index]);
            if (v != null) rec[column.id] = v;
          }
          return rec;
        });
        inserted += insertRecords(table.id, batch, { userId: opts.userId, access: created ? undefined : opts.access }).length;
      }
    });

    audit({
      baseId,
      tableId: table.id,
      userId: opts.userId,
      action: 'import',
      details: { file: opts.filename, sheet: sheet.name, inserted, newTable: created, skippedHeaders },
    });
    return { table: getTable(table.id), inserted, skippedHeaders };
  })();
}

export async function importRoutes(app: FastifyInstance) {
  app.post<{ Params: { baseId: string } }>(
    '/api/v1/bases/:baseId/import/preview',
    { schema: doc('Import', 'Parse a CSV/XLSX/JSON file and infer field types') },
    async (req) => {
      requireBaseRole(req, req.params.baseId, 'editor');
      const up = await readUpload(req);
      const sheets = await parseUpload(up.filename, up.buffer);
      return {
        sheets: sheets.map((s) => {
          const inferred = inferColumns(s);
          return {
            name: s.name,
            headers: s.headers,
            rowCount: s.rows.length,
            sampleRows: s.rows.slice(0, SAMPLE_ROWS).map((r) => r.map(previewValue)),
            inferredTypes: inferred.map((i) => i.type),
            inferredOptions: inferred.map((i) => i.options ?? {}),
          };
        }),
      };
    },
  );

  app.post<{ Params: { baseId: string } }>(
    '/api/v1/bases/:baseId/import',
    { schema: doc('Import', 'Import a CSV/XLSX/JSON file into a new table (tableTitle) or an existing one (tableId, columnMap)') },
    async (req) => {
      const { baseId } = req.params;
      const role = requireBaseRole(req, baseId, 'editor');
      const user = requireUser(req);
      const up = await readUpload(req);
      const sheets = await parseUpload(up.filename, up.buffer);
      const sheet = up.fields.sheet ? sheets.find((s) => s.name === up.fields.sheet) : sheets[0];
      if (!sheet) throw badRequest(up.fields.sheet ? `Sheet "${up.fields.sheet}" not found` : 'The file contains no data');
      let columnMap: Record<string, string> | undefined;
      if (up.fields.columnMap) {
        try {
          columnMap = JSON.parse(up.fields.columnMap) as Record<string, string>;
        } catch {
          throw badRequest('columnMap must be JSON');
        }
      }
      return importSheet({
        baseId,
        userId: user.id,
        filename: up.filename,
        sheet,
        tableId: up.fields.tableId || undefined,
        tableTitle: up.fields.tableTitle || undefined,
        columnMap,
        access: { role },
      });
    },
  );
}
