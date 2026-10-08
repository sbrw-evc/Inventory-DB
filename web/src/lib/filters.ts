import type { Column, FilterCondition, FilterGroup, FilterOp } from '@shared';
import { isFilterGroup, opsForType } from '@shared';

export type FilterNode = FilterCondition | FilterGroup;

let counter = 0;
export const newId = () => `f${Date.now().toString(36)}${(counter++).toString(36)}`;

export const OP_LABELS: Record<FilterOp, string> = {
  eq: 'is',
  neq: 'is not',
  like: 'contains',
  nlike: 'does not contain',
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  blank: 'is blank',
  notblank: 'is not blank',
  checked: 'is checked',
  notchecked: 'is not checked',
  anyof: 'has any of',
  allof: 'has all of',
  nanyof: 'has none of',
  nallof: 'does not have all of',
  isWithin: 'is within',
};

export const WITHIN_OPTIONS = [
  { value: 'pastWeek', label: 'the past week' },
  { value: 'pastMonth', label: 'the past month' },
  { value: 'pastYear', label: 'the past year' },
  { value: 'nextWeek', label: 'the next week' },
  { value: 'nextMonth', label: 'the next month' },
  { value: 'nextYear', label: 'the next year' },
];

const NO_VALUE_OPS: FilterOp[] = ['blank', 'notblank', 'checked', 'notchecked'];
export const opNeedsValue = (op: FilterOp) => !NO_VALUE_OPS.includes(op);
export const opTakesList = (op: FilterOp) => ['anyof', 'allof', 'nanyof', 'nallof'].includes(op);

/** Column types that can be filtered (everything but attachments/JSON). */
export const filterableColumns = (columns: Column[]) =>
  columns.filter((c) => c.type !== 'Attachment' && c.type !== 'JSON');

export function emptyGroup(logic: 'and' | 'or' = 'and'): FilterGroup {
  return { id: newId(), logic, children: [] };
}

export function newCondition(columns: Column[]): FilterCondition {
  const col = filterableColumns(columns)[0];
  const op = col ? opsForType(col.type)[0] : 'eq';
  return { id: newId(), columnId: col?.id ?? '', op, value: defaultValueFor(op) };
}

function defaultValueFor(op: FilterOp): unknown {
  if (!opNeedsValue(op)) return undefined;
  if (opTakesList(op)) return [];
  if (op === 'isWithin') return 'pastWeek';
  return '';
}

/** Ensures every node has an id (server-provided filters may not). Returns a new tree. */
export function withIds(group: FilterGroup | null | undefined): FilterGroup {
  if (!group) return emptyGroup();
  return {
    ...group,
    id: group.id ?? newId(),
    logic: group.logic ?? 'and',
    children: (group.children ?? []).map((c) => (isFilterGroup(c) ? withIds(c) : { ...c, id: c.id ?? newId() })),
  };
}

export function mapNode(root: FilterGroup, id: string, fn: (n: FilterNode) => FilterNode | null): FilterGroup {
  const visit = (g: FilterGroup): FilterGroup => ({
    ...g,
    children: g.children.flatMap((c) => {
      if (c.id === id) {
        const r = fn(c);
        return r ? [r] : [];
      }
      return [isFilterGroup(c) ? visit(c) : c];
    }),
  });
  if (root.id === id) {
    const r = fn(root);
    return r && isFilterGroup(r) ? r : emptyGroup(root.logic);
  }
  return visit(root);
}

export const removeNode = (root: FilterGroup, id: string) => mapNode(root, id, () => null);

export function updateCondition(root: FilterGroup, id: string, patch: Partial<FilterCondition>): FilterGroup {
  return mapNode(root, id, (n) => (isFilterGroup(n) ? n : { ...n, ...patch }));
}

export function setGroupLogic(root: FilterGroup, id: string, logic: 'and' | 'or'): FilterGroup {
  return mapNode(root, id, (n) => (isFilterGroup(n) ? { ...n, logic } : n));
}

export function addChild(root: FilterGroup, groupId: string, child: FilterNode): FilterGroup {
  return mapNode(root, groupId, (n) => (isFilterGroup(n) ? { ...n, children: [...n.children, child] } : n));
}

/** Changing a condition's column keeps the op if still valid for the new type, else resets op and value. */
export function changeConditionColumn(cond: FilterCondition, column: Column): FilterCondition {
  const ops = opsForType(column.type);
  const op = ops.includes(cond.op) ? cond.op : ops[0];
  const sameOp = op === cond.op;
  return { ...cond, columnId: column.id, op, value: sameOp && opNeedsValue(op) ? '' : defaultValueFor(op) };
}

export function changeConditionOp(cond: FilterCondition, op: FilterOp): FilterCondition {
  const listBefore = opTakesList(cond.op);
  const listAfter = opTakesList(op);
  let value = cond.value;
  if (!opNeedsValue(op)) value = undefined;
  else if (listBefore !== listAfter || op === 'isWithin' || cond.op === 'isWithin' || !opNeedsValue(cond.op))
    value = defaultValueFor(op);
  return { ...cond, op, value };
}

export function countConditions(group: FilterGroup | null | undefined): number {
  if (!group) return 0;
  return group.children.reduce((n, c) => n + (isFilterGroup(c) ? countConditions(c) : 1), 0);
}

function isComplete(c: FilterCondition): boolean {
  if (!c.columnId) return false;
  if (!opNeedsValue(c.op)) return true;
  if (opTakesList(c.op)) return Array.isArray(c.value) && c.value.length > 0;
  return c.value !== undefined && c.value !== null && c.value !== '';
}

/**
 * The filter to send to the server: drops incomplete conditions and empty groups.
 * Returns null when nothing is left.
 */
export function cleanFilter(group: FilterGroup | null | undefined): FilterGroup | null {
  if (!group) return null;
  const children = group.children
    .map((c) => (isFilterGroup(c) ? cleanFilter(c) : isComplete(c) ? c : null))
    .filter((c): c is FilterNode => c !== null);
  if (!children.length) return null;
  return { ...group, children };
}

/** Stable comparison used to decide whether a filter edit actually changed what is sent. */
export const filterKey = (g: FilterGroup | null | undefined) => {
  const strip = (n: FilterNode): unknown =>
    isFilterGroup(n) ? { l: n.logic, c: n.children.map(strip) } : { c: n.columnId, o: n.op, v: n.value ?? null };
  const clean = cleanFilter(g);
  return clean ? JSON.stringify(strip(clean)) : '';
};

/** Builds a condition that matches records whose column equals a group value. */
export function conditionForGroupValue(column: Column, value: unknown): FilterCondition {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
    return { columnId: column.id, op: column.type === 'Checkbox' ? 'notchecked' : 'blank' };
  if (column.type === 'Checkbox') {
    const on = value === true || value === 1 || value === '1' || value === 'true';
    return { columnId: column.id, op: on ? 'checked' : 'notchecked' };
  }
  if (column.type === 'MultiSelect') {
    const list = Array.isArray(value) ? value.map(String) : String(value).split(',');
    return { columnId: column.id, op: 'allof', value: list };
  }
  return { columnId: column.id, op: 'eq', value };
}

export function andFilters(...groups: Array<FilterGroup | null | undefined>): FilterGroup | undefined {
  const list = groups.filter((g): g is FilterGroup => !!g && g.children.length > 0);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  return { logic: 'and', children: list };
}
