import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { Column, ListResult, Table, View } from '@shared';
import { ymd } from '../lib/format';
import { permissionsFor } from '../lib/roles';
import { TimelineView } from './TimelineView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const col = (id: string, title: string, type: Column['type'], extra: Partial<Column> = {}): Column => ({
  id,
  tableId: 't1',
  title,
  type,
  primary: false,
  required: false,
  options: {},
  order: 0,
  ...extra,
});

describe('TimelineView', () => {
  it('renders one bar per record in swimlanes and opens a record on click', async () => {
    const table: Table = {
      id: 't1',
      baseId: 'b1',
      title: 'Projects',
      order: 1,
      columns: [
        col('name', 'Name', 'SingleLineText', { primary: true }),
        col('start', 'Start', 'Date'),
        col('end', 'End', 'Date'),
        col('status', 'Status', 'SingleSelect', { options: { choices: [{ title: 'Open', color: '#DAE8FC' }, { title: 'Done', color: '#D5E8D4' }] } }),
      ],
    };
    const view: View = {
      id: 'v1',
      tableId: 't1',
      title: 'Plan',
      type: 'timeline',
      order: 1,
      locked: false,
      filter: null,
      sorts: [],
      columns: [],
      meta: { dateColumnId: 'start', endDateColumnId: 'end', groupColumnId: 'status', timelineScale: 'week' },
    };
    const today = new Date();
    const d = (n: number) => ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
    const list: ListResult = {
      list: [
        { id: 1, name: 'Alpha', start: d(0), end: d(3), status: 'Open' },
        { id: 2, name: 'Beta', start: d(1), end: null, status: 'Done' },
      ],
      pageInfo: { totalRows: 2, offset: 0, limit: 1000, isLastPage: true },
    };
    const listFn = vi.fn(async () => list);
    const onOpen = vi.fn();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    const qc = new QueryClient();
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <TimelineView
            table={table}
            view={view}
            source={{ key: ['records', 't1', 'v1'], tableId: 't1', list: listFn }}
            baseQuery={{}}
            perms={permissionsFor('editor')}
            onOpen={onOpen}
            onAdd={() => {}}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const bars = el.querySelectorAll('.timeline-bar');
    expect([...bars].map((b) => b.textContent)).toEqual(['Alpha', 'Beta']);
    expect(el.querySelectorAll('.timeline-lane-head')).toHaveLength(2);
    // The overlap filter asks for records whose end is after the range start (or with no end).
    expect(JSON.stringify((listFn.mock.calls[0] as unknown[])[0])).toContain('"op":"blank"');
    await act(async () => {
      (bars[0] as HTMLElement).click();
    });
    expect(onOpen).toHaveBeenCalledWith(1);
    root.unmount();
  });
});
