import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ColumnInput, FilterGroup } from '../../../shared/src/index.js';
import { FIELD_TYPES, FILTER_OPS } from '../../../shared/src/index.js';
import { requireBaseRole, requireColumnRole, requireTableRole, requireUser, requireViewRole } from '../auth/plugin.js';
import { getBaseRole } from '../auth/service.js';
import { forbidden } from '../errors.js';
import {
  addColumn,
  createBase,
  createTable,
  createView,
  deleteBase,
  deleteColumn,
  deleteTable,
  deleteView,
  getBase,
  getColumn,
  getTable,
  getView,
  listBases,
  updateBase,
  updateColumn,
  updateTable,
  updateView,
} from '../meta/service.js';

const baseBody = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(10000).nullable().optional(),
  color: z.string().max(50).nullable().optional(),
});
const basePatch = baseBody.partial().extend({ order: z.number().optional() });

const columnInput = z.object({
  title: z.string().min(1).max(255),
  type: z.enum(FIELD_TYPES),
  options: z.record(z.unknown()).optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  description: z.string().max(10000).nullable().optional(),
  primary: z.boolean().optional(),
});

const tableBody = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(10000).nullable().optional(),
  columns: z.array(columnInput).optional(),
});
const tablePatch = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(10000).nullable().optional(),
  order: z.number().optional(),
});

const filterCondition = z.object({
  id: z.string().optional(),
  columnId: z.string(),
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional(),
});
export const filterGroup: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    id: z.string().optional(),
    logic: z.enum(['and', 'or']),
    children: z.array(z.union([filterGroup, filterCondition])),
  }),
) as z.ZodType<FilterGroup>;
export const sortList = z.array(z.object({ columnId: z.string(), direction: z.enum(['asc', 'desc']) }));

const viewType = z.enum(['grid', 'form', 'gallery', 'kanban', 'calendar']);
const viewBody = z.object({ title: z.string().min(1).max(255), type: viewType, copyFromViewId: z.string().optional() });
const viewPatch = z.object({
  title: z.string().min(1).max(255).optional(),
  order: z.number().optional(),
  locked: z.boolean().optional(),
  filter: filterGroup.nullable().optional(),
  sorts: sortList.optional(),
  columns: z
    .array(
      z.object({
        columnId: z.string(),
        show: z.boolean(),
        order: z.number(),
        width: z.number().optional(),
        label: z.string().optional(),
        help: z.string().optional(),
        required: z.boolean().optional(),
      }),
    )
    .optional(),
  meta: z.record(z.unknown()).optional(),
});

type P<K extends string> = { Params: Record<K, string> };

export async function metaRoutes(app: FastifyInstance) {
  // Bases
  app.get('/api/v1/bases', async (req) => listBases(requireUser(req).id));

  app.post('/api/v1/bases', async (req) => createBase(requireUser(req).id, baseBody.parse(req.body)));

  app.get<P<'baseId'>>('/api/v1/bases/:baseId', async (req) => {
    const role = requireBaseRole(req, req.params.baseId, 'viewer');
    return { ...getBase(req.params.baseId), role };
  });

  app.patch<P<'baseId'>>('/api/v1/bases/:baseId', async (req) => {
    const role = requireBaseRole(req, req.params.baseId, 'owner');
    return { ...updateBase(req.params.baseId, basePatch.parse(req.body)), role };
  });

  app.delete<P<'baseId'>>('/api/v1/bases/:baseId', async (req) => {
    requireBaseRole(req, req.params.baseId, 'owner');
    deleteBase(req.params.baseId);
    return { ok: true };
  });

  // Tables
  app.post<P<'baseId'>>('/api/v1/bases/:baseId/tables', async (req) => {
    requireBaseRole(req, req.params.baseId, 'editor');
    const body = tableBody.parse(req.body);
    return createTable(req.params.baseId, { ...body, columns: body.columns as ColumnInput[] | undefined });
  });

  app.get<P<'tableId'>>('/api/v1/tables/:tableId', async (req) => {
    requireTableRole(req, req.params.tableId, 'viewer');
    return getTable(req.params.tableId);
  });

  app.patch<P<'tableId'>>('/api/v1/tables/:tableId', async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    return updateTable(req.params.tableId, tablePatch.parse(req.body));
  });

  app.delete<P<'tableId'>>('/api/v1/tables/:tableId', async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    deleteTable(req.params.tableId);
    return { ok: true };
  });

  // Columns
  app.post<P<'tableId'>>('/api/v1/tables/:tableId/columns', async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    return addColumn(req.params.tableId, columnInput.parse(req.body) as ColumnInput);
  });

  app.get<P<'columnId'>>('/api/v1/columns/:columnId', async (req) => {
    requireColumnRole(req, req.params.columnId, 'viewer');
    return getColumn(req.params.columnId);
  });

  app.patch<P<'columnId'>>('/api/v1/columns/:columnId', async (req) => {
    requireColumnRole(req, req.params.columnId, 'editor');
    return updateColumn(req.params.columnId, columnInput.partial().parse(req.body) as Partial<ColumnInput>);
  });

  app.delete<P<'columnId'>>('/api/v1/columns/:columnId', async (req) => {
    requireColumnRole(req, req.params.columnId, 'editor');
    deleteColumn(req.params.columnId);
    return { ok: true };
  });

  // Views
  app.post<P<'tableId'>>('/api/v1/tables/:tableId/views', async (req) => {
    requireTableRole(req, req.params.tableId, 'editor');
    return createView(req.params.tableId, viewBody.parse(req.body));
  });

  app.get<P<'viewId'>>('/api/v1/views/:viewId', async (req) => {
    requireViewRole(req, req.params.viewId, 'viewer');
    return getView(req.params.viewId);
  });

  app.patch<P<'viewId'>>('/api/v1/views/:viewId', async (req) => {
    const { baseId } = requireViewRole(req, req.params.viewId, 'editor');
    const role = getBaseRole(baseId, requireUser(req).id);
    const patch = viewPatch.parse(req.body);
    const view = getView(req.params.viewId);
    if (role !== 'owner') {
      // Editors may lock a view, but only owners may unlock or change a locked view.
      if (view.locked) throw forbidden('This view is locked; only an owner can change it');
    }
    return updateView(req.params.viewId, patch);
  });

  app.delete<P<'viewId'>>('/api/v1/views/:viewId', async (req) => {
    const { baseId } = requireViewRole(req, req.params.viewId, 'editor');
    if (getView(req.params.viewId).locked && getBaseRole(baseId, requireUser(req).id) !== 'owner')
      throw forbidden('This view is locked; only an owner can delete it');
    deleteView(req.params.viewId);
    return { ok: true };
  });
}
