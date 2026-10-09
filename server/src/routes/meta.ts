import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ColumnInput, FilterGroup, Role, ViewMeta, ViewType } from '../../../shared/src/index.js';
import { FIELD_TYPES, FILTER_OPS, VIEW_TYPES } from '../../../shared/src/index.js';
import { requireBaseRole, requireColumnRole, requireTableAccess, requireUser, requireViewRole } from '../auth/plugin.js';
import { getBaseRole } from '../auth/service.js';
import { assertFilterVisible, assertSortsVisible, hiddenColumnIdsForRole, tableForRole, viewForHidden } from '../data/access.js';
import { forbidden, notFound } from '../errors.js';
import { loadColumn } from '../meta/store.js';
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

const viewType = z.enum(VIEW_TYPES as [ViewType, ...ViewType[]]);
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

/** Column-scoped role check that also treats a field hidden for the caller as missing (404). */
function requireVisibleColumn(req: Parameters<typeof requireColumnRole>[0], columnId: string, min: Role) {
  const { baseId, tableId } = requireColumnRole(req, columnId, min);
  const role = getBaseRole(baseId, requireUser(req).id)!;
  if (role !== 'owner' && hiddenColumnIdsForRole(tableId, role).has(columnId)) throw notFound('Column');
  return { baseId, tableId, role };
}

/** Column references in a view patch must be visible to non-owners (400 like unknown fields). */
function assertViewPatchVisible(tableId: string, role: Role, patch: { filter?: FilterGroup | null; sorts?: { columnId: string; direction: 'asc' | 'desc' }[]; meta?: Record<string, unknown> }) {
  if (role === 'owner') return;
  const hidden = hiddenColumnIdsForRole(tableId, role);
  if (!hidden.size) return;
  assertFilterVisible(patch.filter, hidden);
  assertSortsVisible(patch.sorts, hidden);
  const meta = (patch.meta ?? {}) as ViewMeta;
  assertSortsVisible(meta.groupBy, hidden, 'Group');
  for (const k of ['groupColumnId', 'coverColumnId', 'dateColumnId', 'endDateColumnId', 'geoColumnId'] as const) {
    const id = meta[k];
    if (typeof id === 'string' && hidden.has(id)) throw notFound('Column');
  }
}

export async function metaRoutes(app: FastifyInstance) {
  // Bases
  app.get('/api/v1/bases', async (req) => listBases(requireUser(req).id));

  app.post('/api/v1/bases', async (req) => createBase(requireUser(req).id, baseBody.parse(req.body)));

  app.get<P<'baseId'>>('/api/v1/bases/:baseId', async (req) => {
    const role = requireBaseRole(req, req.params.baseId, 'viewer');
    const base = getBase(req.params.baseId);
    return { ...base, tables: base.tables.map((t) => tableForRole(t, role)), role };
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
    const role = requireBaseRole(req, req.params.baseId, 'editor');
    const body = tableBody.parse(req.body);
    if (role !== 'owner' && body.columns?.some((c) => (c.options as { permissions?: unknown } | undefined)?.permissions))
      throw forbidden('Only owners can set field permissions');
    return createTable(req.params.baseId, { ...body, columns: body.columns as ColumnInput[] | undefined });
  });

  app.get<P<'tableId'>>('/api/v1/tables/:tableId', async (req) => {
    const { role } = requireTableAccess(req, req.params.tableId, 'viewer');
    return tableForRole(getTable(req.params.tableId), role);
  });

  app.patch<P<'tableId'>>('/api/v1/tables/:tableId', async (req) => {
    const { role } = requireTableAccess(req, req.params.tableId, 'editor');
    return tableForRole(updateTable(req.params.tableId, tablePatch.parse(req.body)), role);
  });

  app.delete<P<'tableId'>>('/api/v1/tables/:tableId', async (req) => {
    requireTableAccess(req, req.params.tableId, 'editor');
    deleteTable(req.params.tableId);
    return { ok: true };
  });

  // Columns
  app.post<P<'tableId'>>('/api/v1/tables/:tableId/columns', async (req) => {
    const { role } = requireTableAccess(req, req.params.tableId, 'editor');
    const input = columnInput.parse(req.body) as ColumnInput;
    if (role !== 'owner' && input.options?.permissions) throw forbidden('Only owners can set field permissions');
    return addColumn(req.params.tableId, input);
  });

  app.get<P<'columnId'>>('/api/v1/columns/:columnId', async (req) => {
    requireVisibleColumn(req, req.params.columnId, 'viewer');
    return getColumn(req.params.columnId);
  });

  app.patch<P<'columnId'>>('/api/v1/columns/:columnId', async (req) => {
    const { role } = requireVisibleColumn(req, req.params.columnId, 'editor');
    const patch = columnInput.partial().parse(req.body) as Partial<ColumnInput>;
    if (role !== 'owner' && patch.options && 'permissions' in patch.options) {
      const cur = loadColumn(req.params.columnId).options.permissions ?? null;
      if (JSON.stringify(cur) !== JSON.stringify(patch.options.permissions ?? null)) throw forbidden('Only owners can change field permissions');
    }
    return updateColumn(req.params.columnId, patch);
  });

  app.delete<P<'columnId'>>('/api/v1/columns/:columnId', async (req) => {
    requireVisibleColumn(req, req.params.columnId, 'editor');
    deleteColumn(req.params.columnId);
    return { ok: true };
  });

  // Views
  app.post<P<'tableId'>>('/api/v1/tables/:tableId/views', async (req) => {
    const { role } = requireTableAccess(req, req.params.tableId, 'editor');
    return viewForHidden(createView(req.params.tableId, viewBody.parse(req.body)), hiddenColumnIdsForRole(req.params.tableId, role));
  });

  app.get<P<'viewId'>>('/api/v1/views/:viewId', async (req) => {
    const { baseId, tableId } = requireViewRole(req, req.params.viewId, 'viewer');
    const role = getBaseRole(baseId, requireUser(req).id)!;
    return viewForHidden(getView(req.params.viewId), hiddenColumnIdsForRole(tableId, role));
  });

  app.patch<P<'viewId'>>('/api/v1/views/:viewId', async (req) => {
    const { baseId, tableId } = requireViewRole(req, req.params.viewId, 'editor');
    const role = getBaseRole(baseId, requireUser(req).id)!;
    const patch = viewPatch.parse(req.body);
    assertViewPatchVisible(tableId, role, patch);
    const view = getView(req.params.viewId);
    if (role !== 'owner') {
      // Editors may lock a view, but only owners may unlock or change a locked view.
      if (view.locked) throw forbidden('This view is locked; only an owner can change it');
    }
    return viewForHidden(updateView(req.params.viewId, patch), hiddenColumnIdsForRole(tableId, role));
  });

  app.delete<P<'viewId'>>('/api/v1/views/:viewId', async (req) => {
    const { baseId } = requireViewRole(req, req.params.viewId, 'editor');
    if (getView(req.params.viewId).locked && getBaseRole(baseId, requireUser(req).id) !== 'owner')
      throw forbidden('This view is locked; only an owner can delete it');
    deleteView(req.params.viewId);
    return { ok: true };
  });
}
