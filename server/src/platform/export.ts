import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import Papa from 'papaparse';
import { PassThrough, Readable } from 'node:stream';
import type { RecordData } from '../../../shared/src/index.js';
import { requireUser, requireViewRole } from '../auth/plugin.js';
import { getBaseRole } from '../auth/service.js';
import { listRecords } from '../data/records.js';
import { badRequest } from '../errors.js';
import { getTable, getView } from '../meta/service.js';
import { doc } from './docs.js';
import { renderValue, xlsxValue } from './render.js';
import { shownColumns, type ShownColumn } from './viewColumns.js';

export const EXPORT_PAGE = 1000;

/** All rows of a view (its filters/sorts applied), one page at a time. */
export function* viewRows(tableId: string, viewId: string, fields: string[]): Generator<RecordData[]> {
  for (let offset = 0; ; offset += EXPORT_PAGE) {
    const page = listRecords(tableId, { viewId, offset, limit: EXPORT_PAGE, fields });
    if (page.list.length) yield page.list;
    if (page.pageInfo.isLastPage || page.list.length < EXPORT_PAGE) return;
  }
}

/** `filename*` per RFC 5987 plus an ASCII fallback. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\/]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function csvStream(tableId: string, viewId: string, cols: ShownColumn[]): Readable {
  const fields = cols.map((c) => c.column.id);
  return Readable.from(
    (function* () {
      yield '﻿' + Papa.unparse([cols.map((c) => c.column.title)]) + '\r\n';
      for (const page of viewRows(tableId, viewId, fields)) {
        yield Papa.unparse(page.map((r) => cols.map(({ column }) => renderValue(column, r[column.id])))) + '\r\n';
      }
    })(),
  );
}

function xlsxStream(tableId: string, viewId: string, sheetName: string, cols: ShownColumn[]): Readable {
  const out = new PassThrough();
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true });
  const ws = wb.addWorksheet(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  ws.columns = cols.map(({ column, viewColumn }) => ({ header: column.title, width: Math.min(60, Math.max(10, Math.round((viewColumn?.width ?? 150) / 7))) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).commit();
  (async () => {
    for (const page of viewRows(tableId, viewId, cols.map((c) => c.column.id))) {
      for (const r of page) ws.addRow(cols.map(({ column }) => xlsxValue(column, r[column.id]))).commit();
      await new Promise((res) => setImmediate(res)); // let the stream drain between pages
    }
    ws.commit();
    await wb.commit();
  })().catch((err) => out.destroy(err as Error));
  return out;
}

export async function exportRoutes(app: FastifyInstance) {
  app.get<{ Params: { viewId: string }; Querystring: { format?: string } }>(
    '/api/v1/views/:viewId/export',
    { schema: doc('Export', 'Download all rows of a view as CSV or XLSX (respects filters, sorts and hidden fields)') },
    async (req, reply) => {
      const { tableId, baseId } = requireViewRole(req, req.params.viewId, 'viewer');
      const role = getBaseRole(baseId, requireUser(req).id) ?? 'viewer';
      const format = (req.query.format ?? 'csv').toLowerCase();
      if (format !== 'csv' && format !== 'xlsx') throw badRequest('format must be csv or xlsx');
      const view = getView(req.params.viewId);
      const table = getTable(tableId);
      const cols = shownColumns(table, view, { role });
      const filename = `${table.title} - ${view.title}.${format}`;
      reply.header('Content-Disposition', contentDisposition(filename));
      if (format === 'csv') {
        reply.type('text/csv; charset=utf-8');
        return reply.send(csvStream(tableId, view.id, cols));
      }
      reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return reply.send(xlsxStream(tableId, view.id, view.title, cols));
    },
  );
}
