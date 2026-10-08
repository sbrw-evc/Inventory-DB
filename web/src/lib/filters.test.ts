import { describe, expect, it } from 'vitest';
import type { Column, FilterCondition, FilterGroup } from '@shared';
import {
  addChild,
  andFilters,
  changeConditionColumn,
  changeConditionOp,
  cleanFilter,
  conditionForGroupValue,
  countConditions,
  emptyGroup,
  filterKey,
  newCondition,
  removeNode,
  setGroupLogic,
  updateCondition,
  withIds,
} from './filters';

const column = (id: string, type: Column['type']): Column => ({
  id,
  tableId: 't',
  title: id,
  type,
  primary: false,
  required: false,
  options: {},
  order: 0,
});
const cols = [column('name', 'SingleLineText'), column('qty', 'Number'), column('status', 'SingleSelect'), column('done', 'Checkbox')];

describe('filter tree editing', () => {
  it('adds, updates and removes conditions in nested groups', () => {
    let root = emptyGroup();
    const c1 = newCondition(cols);
    root = addChild(root, root.id!, c1);
    const inner = { ...emptyGroup('or'), children: [] };
    root = addChild(root, root.id!, inner);
    const c2 = newCondition(cols);
    root = addChild(root, inner.id!, c2);
    expect(countConditions(root)).toBe(2);

    root = updateCondition(root, c2.id!, { value: 'x' });
    const innerAfter = root.children[1] as FilterGroup;
    expect((innerAfter.children[0] as FilterCondition).value).toBe('x');

    root = setGroupLogic(root, inner.id!, 'and');
    expect((root.children[1] as FilterGroup).logic).toBe('and');

    root = removeNode(root, c1.id!);
    expect(countConditions(root)).toBe(1);
  });

  it('assigns ids to server filters', () => {
    const g = withIds({ logic: 'and', children: [{ columnId: 'qty', op: 'gt', value: 1 }] });
    expect(g.id).toBeTruthy();
    expect(g.children[0].id).toBeTruthy();
    expect(withIds(null).children).toEqual([]);
  });

  it('resets op and value when the column type changes', () => {
    const c: FilterCondition = { id: 'a', columnId: 'name', op: 'like', value: 'abc' };
    const moved = changeConditionColumn(c, cols[1]);
    expect(moved.columnId).toBe('qty');
    expect(moved.op).toBe('eq');
    const toCheckbox = changeConditionColumn(c, cols[3]);
    expect(toCheckbox.op).toBe('checked');
    expect(toCheckbox.value).toBeUndefined();
  });

  it('switches value shape between scalar and list ops', () => {
    const c: FilterCondition = { id: 'a', columnId: 'status', op: 'eq', value: 'Open' };
    expect(changeConditionOp(c, 'anyof').value).toEqual([]);
    expect(changeConditionOp(c, 'blank').value).toBeUndefined();
    expect(changeConditionOp(c, 'neq').value).toBe('Open');
  });

  it('cleans incomplete conditions and empty groups', () => {
    const g: FilterGroup = {
      logic: 'and',
      children: [
        { columnId: 'name', op: 'eq', value: '' },
        { columnId: 'done', op: 'checked' },
        { logic: 'or', children: [{ columnId: 'status', op: 'anyof', value: [] }] },
      ],
    };
    const clean = cleanFilter(g)!;
    expect(clean.children).toHaveLength(1);
    expect(cleanFilter({ logic: 'and', children: [] })).toBeNull();
    expect(filterKey(g)).toBe(filterKey(clean));
  });

  it('builds group-value conditions and combines filters', () => {
    expect(conditionForGroupValue(cols[2], null).op).toBe('blank');
    expect(conditionForGroupValue(cols[3], true).op).toBe('checked');
    expect(conditionForGroupValue(cols[2], 'Open')).toEqual({ columnId: 'status', op: 'eq', value: 'Open' });
    const a: FilterGroup = { logic: 'and', children: [{ columnId: 'qty', op: 'gt', value: 1 }] };
    expect(andFilters(a, undefined)).toBe(a);
    expect(andFilters(a, a)!.children).toHaveLength(2);
    expect(andFilters(null, { logic: 'and', children: [] })).toBeUndefined();
  });
});
