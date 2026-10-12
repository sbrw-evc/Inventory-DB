import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowTrafficCard, PrefixFlowAddresses } from './flow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter>{node}</MemoryRouter>));
  // Let the fetch promise and the state update settle.
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  return host;
}

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('Umbrella Flow UI', () => {
  it('hides the traffic card when there is no Flow integration or Flow fails', async () => {
    for (const status of [404, 502]) {
      vi.stubGlobal('fetch', respond(status, { error: 'NOT_FOUND', message: 'Flow integration not found' }));
      const el = await render(<FlowTrafficCard objectType="dcim.device" id={1} />);
      expect(el.textContent).toBe('');
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it('shows rates, the sparkline, commit and the link to Flow', async () => {
    const fetch = respond(200, {
      window: '24h',
      results: {
        '7': {
          in_bps: 7.2e9,
          out_bps: 1.3e9,
          speed_bps: 1e10,
          utilization_in: 0.72,
          utilization_out: 0.13,
          p95_month_bps: 6.9e9,
          commit_bps: 5e9,
          over_commit: true,
          sparkline: { t: ['2026-10-12T09:00:00Z', '2026-10-12T09:30:00Z'], in: [1, 2], out: [0.5, 0.7] },
          flow_url: 'https://flow.corp/visualize?q=x',
          last_seen: '2026-10-12T10:46:00Z',
        },
      },
    });
    vi.stubGlobal('fetch', fetch);
    const el = await render(<FlowTrafficCard objectType="circuits.circuit" id={7} commit />);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe('/api/v1/integrations/flow/status?object_type=circuits.circuit&ids=7');
    expect(el.textContent).toContain('7.2 Gb/s');
    expect(el.textContent).toContain('Over commit');
    expect(el.querySelectorAll('polyline')).toHaveLength(2);
    expect(el.textContent).toContain('Peak: 2 b/s');
    expect(el.querySelector('a[href="https://flow.corp/visualize?q=x"]')?.textContent).toContain('Open in Flow');
  });

  it('shows no made-up peak when the window has no traffic', async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, {
        window: '24h',
        results: {
          '2': {
            in_bps: 0, out_bps: 0, speed_bps: null, utilization_in: null, utilization_out: null,
            sparkline: { t: ['2026-10-11T21:30:00Z', '2026-10-11T22:00:00Z'], in: [0, 0], out: [0, 0] },
            flow_url: 'https://flow.corp/visualize?q=y', last_seen: null,
          },
        },
      }),
    );
    const el = await render(<FlowTrafficCard objectType="dcim.device" id={2} />);
    expect(el.textContent).toContain('No traffic in the window');
    expect(el.textContent).not.toContain('Peak');
  });

  it('lists active addresses and offers to create the ones missing from IPAM', async () => {
    vi.stubGlobal(
      'fetch',
      respond(200, {
        prefix: '10.0.0.0/24',
        results: [
          { address: '10.0.0.7', bytes: 2048, flows: 4, last_seen: null, in_ipam: true, ip_address_id: 3 },
          { address: '10.0.0.8', bytes: 10, flows: 1, last_seen: null, in_ipam: false, ip_address_id: null },
        ],
      }),
    );
    const onCreate = vi.fn();
    const prefix = { id: 1, url: '', display: '10.0.0.0/24', prefix: '10.0.0.0/24', vrf: { id: 2, url: '', display: 'blue' } };
    const el = await render(<PrefixFlowAddresses prefix={prefix} canWrite onCreate={onCreate} version={1} />);
    expect(el.textContent).toContain('Active addresses (Flow) (2)');
    const buttons = [...el.querySelectorAll('button')].filter((b) => b.textContent?.includes('Create IP address'));
    expect(buttons).toHaveLength(1);
    act(() => buttons[0].click());
    expect(onCreate).toHaveBeenCalledWith({ address: '10.0.0.8/24', status: 'active', description: 'Discovered by Umbrella Flow', vrf: 2 });
  });
});
