import type { Column, FieldType, ViewColumn, ViewType } from '@shared';
import { isReadOnlyType } from '@shared';

export interface ResolvedColumn {
  column: Column;
  show: boolean;
  width: number;
  label?: string;
  help?: string;
  required?: boolean;
}

export function defaultWidth(type: FieldType, primary = false): number {
  if (primary) return 220;
  switch (type) {
    case 'Checkbox':
      return 100;
    case 'ID':
      return 80;
    case 'Rating':
      return 130;
    case 'LongText':
    case 'MultiSelect':
    case 'Attachment':
    case 'JSON':
      return 220;
    case 'Number':
    case 'Decimal':
    case 'Currency':
    case 'Percent':
      return 130;
    default:
      return 170;
  }
}

/** Columns that make sense in a data-entry form. */
export const formCompatible = (c: Column) => !isReadOnlyType(c.type);

/**
 * Merges table columns with the view's per-column settings into display order.
 * Columns the view doesn't know yet are appended (shown, except ID in grids and read-only fields in forms).
 * In non-form views the primary column always comes first.
 */
export function resolveViewColumns(columns: Column[], viewCols: ViewColumn[] | undefined, viewType: ViewType): ResolvedColumn[] {
  const settings = new Map((viewCols ?? []).map((vc) => [vc.columnId, vc]));
  const candidates = viewType === 'form' ? columns.filter(formCompatible) : columns;
  const known = candidates
    .filter((c) => settings.has(c.id))
    .sort((a, b) => settings.get(a.id)!.order - settings.get(b.id)!.order);
  const unknown = candidates.filter((c) => !settings.has(c.id)).sort((a, b) => a.order - b.order);
  let ordered = [...known, ...unknown];
  if (viewType !== 'form') {
    const primary = ordered.find((c) => c.primary);
    if (primary) ordered = [primary, ...ordered.filter((c) => c !== primary)];
  }
  return ordered.map((column) => {
    const vc = settings.get(column.id);
    const defaultShow = column.type !== 'ID';
    return {
      column,
      show: column.primary && viewType !== 'form' ? true : vc ? vc.show : defaultShow,
      width: vc?.width ?? defaultWidth(column.type, column.primary),
      label: vc?.label,
      help: vc?.help,
      required: vc?.required,
    };
  });
}

export function toViewColumns(resolved: ResolvedColumn[]): ViewColumn[] {
  return resolved.map((r, i) => {
    const vc: ViewColumn = { columnId: r.column.id, show: r.show, order: i + 1, width: r.width };
    if (r.label) vc.label = r.label;
    if (r.help) vc.help = r.help;
    if (r.required !== undefined) vc.required = r.required;
    return vc;
  });
}

/** Moves the column `fromId` to the position of `toId`. */
export function moveColumn(resolved: ResolvedColumn[], fromId: string, toId: string): ResolvedColumn[] {
  const from = resolved.findIndex((r) => r.column.id === fromId);
  const to = resolved.findIndex((r) => r.column.id === toId);
  if (from < 0 || to < 0 || from === to) return resolved;
  const next = [...resolved];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function patchResolved(
  resolved: ResolvedColumn[],
  columnId: string,
  patch: Partial<Omit<ResolvedColumn, 'column'>>,
): ResolvedColumn[] {
  return resolved.map((r) => (r.column.id === columnId ? { ...r, ...patch } : r));
}
