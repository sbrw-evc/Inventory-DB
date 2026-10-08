import type { Ctx, Errors, FieldDef, Row } from '../types.js';

export const nameF = (maxLength = 100): FieldDef => ({ name: 'name', kind: 'string', required: true, maxLength, search: true });
export const slugF: FieldDef = { name: 'slug', kind: 'slug', required: true, maxLength: 100 };
export const descriptionF: FieldDef = { name: 'description', kind: 'string', maxLength: 200, search: true };
export const commentsF: FieldDef = { name: 'comments', kind: 'text', search: true };
export const tenantF: FieldDef = { name: 'tenant', kind: 'fk', ref: 'tenancy.tenant' };
export const colorF = (def = '9e9e9e'): FieldDef => ({ name: 'color', kind: 'color', default: def });

export const addError = (errors: Errors, field: string, msg: string) => {
  (errors[field] ??= []).push(msg);
};

export const count = (ctx: Ctx, sql: string, ...params: unknown[]) =>
  (ctx.db.prepare(sql).get(...params) as { n: number }).n;

/** Walks `parent_id` links and reports a cycle when the chain reaches `selfId`. */
export function checkTreeCycle(ctx: Ctx, type: string, rec: Row, errors: Errors) {
  if (rec.id == null || rec.parent_id == null) return;
  let cur: number | null = rec.parent_id;
  const seen = new Set<number>();
  while (cur != null && !seen.has(cur)) {
    if (cur === rec.id) {
      addError(errors, 'parent', 'Cannot assign self or a child as parent.');
      return;
    }
    seen.add(cur);
    cur = ctx.get(type, cur)?.parent_id ?? null;
  }
}

/** Depth in a parent_id tree (0 for roots). */
export function treeDepth(ctx: Ctx, type: string, row: Row): number {
  let depth = 0;
  let cur = row.parent_id;
  const seen = new Set<number>();
  while (cur != null && !seen.has(cur) && depth < 100) {
    seen.add(cur);
    depth++;
    cur = ctx.get(type, cur)?.parent_id ?? null;
  }
  return depth;
}

export const STATUS_DEFAULT = 'active';
