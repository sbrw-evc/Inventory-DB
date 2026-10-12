/**
 * Server-side calls from Inventory DB to Umbrella Flow (contract §2.1). The browser never sees the Flow token: the UI
 * calls the proxy endpoints in routes/integrations.ts, which call Flow with the token from the secret store.
 */
import type { Integration } from '../../../../shared/src/index.js';
import { HttpError } from '../../errors.js';
import { getFlowToken } from '../store.js';

/** Successful answers are reused for this long (per integration and query). */
export const FLOW_CACHE_TTL_MS = 60_000;
/** Failures are remembered briefly so a Flow outage doesn't turn every page view into a slow request. */
const FLOW_ERROR_TTL_MS = 15_000;
const timeouts = { requestMs: 5_000 };

/** Tests. */
export function setFlowTimeout(ms: number) {
  timeouts.requestMs = ms;
}

type Entry = { at: number; ttl: number; value: Promise<unknown> };
const cache = new Map<string, Entry>();
const MAX_ENTRIES = 2000;

export function clearFlowCache() {
  cache.clear();
}

/** Errors the proxy endpoints pass on: 404 when Flow doesn't know the thing, 502 for everything else. */
export class FlowError extends HttpError {
  constructor(status: 404 | 502, message: string) {
    super(status, status === 404 ? 'NOT_FOUND' : 'BAD_GATEWAY', message);
  }
}

async function fetchJson(integration: Integration, path: string): Promise<unknown> {
  const token = await getFlowToken(integration.id);
  if (!token) throw new FlowError(502, 'No Flow API token is stored for the integration');
  let res: Response;
  try {
    res = await fetch(`${integration.flowUrl}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeouts.requestMs),
      redirect: 'error',
    });
  } catch (err) {
    const timeout = (err as Error).name === 'TimeoutError';
    throw new FlowError(502, timeout ? 'Umbrella Flow did not answer in time' : 'Umbrella Flow is unreachable');
  }
  if (res.status === 404) throw new FlowError(404, 'Not found in Umbrella Flow');
  if (!res.ok) throw new FlowError(502, `Umbrella Flow answered ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new FlowError(502, 'Umbrella Flow sent an invalid response');
  }
}

/** GET `{flowUrl}{path}?{query}` with the integration's token, cached for a minute. */
export function flowGet<T>(integration: Integration, path: string, query: Record<string, string | undefined>): Promise<T> {
  const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => !!e[1])).toString();
  const full = `${path}${qs ? `?${qs}` : ''}`;
  const key = `${integration.id}|${integration.flowUrl}|${full}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value as Promise<T>;
  if (cache.size >= MAX_ENTRIES) {
    for (const [k, e] of cache) if (Date.now() - e.at >= e.ttl) cache.delete(k);
    if (cache.size >= MAX_ENTRIES) cache.clear();
  }
  const entry: Entry = { at: Date.now(), ttl: FLOW_CACHE_TTL_MS, value: fetchJson(integration, full) };
  cache.set(key, entry);
  entry.value.catch(() => {
    entry.ttl = FLOW_ERROR_TTL_MS;
    entry.at = Date.now();
  });
  return entry.value as Promise<T>;
}
