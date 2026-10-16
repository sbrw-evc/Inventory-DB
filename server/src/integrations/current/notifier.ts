/**
 * Change notifications to Current (contract §2.2): every committed DCIM / IPAM / circuits change is queued per
 * active `flow` integration; the queue is sent as one signed POST at most once per `intervalMs` (5 s), so bursts
 * (bulk edits, CSV imports) coalesce into a single request. Failed deliveries are retried with backoff; the result of
 * the last delivery is shown on the Integrations page.
 */
import type { FlowDelivery } from '../../../../shared/src/index.js';
import { netboxEvents, type NetboxEventPayload, type NetboxEvents } from '../../netbox/events.js';
import { sign } from '../secrets.js';
import { activeFlowIntegrations, recordActivity, signingSecrets } from '../store.js';

export interface FlowHookEvent {
  event: keyof NetboxEvents;
  object_type: string;
  id: number;
}

export interface FlowHookBody {
  integration_id: string;
  events: FlowHookEvent[];
  sent_at: string;
}

const NOTIFIED_APPS = ['dcim.', 'ipam.', 'circuits.'];
/** A batch never carries more than this; the rest go in the next request. */
export const MAX_BATCH = 1000;

const options = {
  /** At most one request per integration in this window. */
  intervalMs: 5_000,
  /** Waits between attempts of one batch (length = retries). Each is at least the interval. */
  retryDelaysMs: [5_000, 30_000, 120_000],
  timeoutMs: 10_000,
};

/** Tests. */
export function configureFlowNotifier(patch: Partial<typeof options>) {
  Object.assign(options, patch);
}

interface Queue {
  /** Pending events keyed by `object_type:id` (the latest event of an object wins; a create stays a create). */
  pending: Map<string, FlowHookEvent>;
  timer: NodeJS.Timeout | null;
  sending: boolean;
  lastSentAt: number;
}

const queues = new Map<string, Queue>();
let listening = false;

const queueOf = (id: string): Queue => {
  let q = queues.get(id);
  if (!q) queues.set(id, (q = { pending: new Map(), timer: null, sending: false, lastSentAt: 0 }));
  return q;
};

function enqueue(event: keyof NetboxEvents, payload: NetboxEventPayload) {
  if (!NOTIFIED_APPS.some((p) => payload.objectType.startsWith(p))) return;
  let integrations;
  try {
    integrations = activeFlowIntegrations();
  } catch {
    return; // database not open (tests that never configure one)
  }
  for (const integration of integrations) {
    const q = queueOf(integration.id);
    const key = `${payload.objectType}:${payload.id}`;
    const prev = q.pending.get(key);
    // created + updated → created; anything + deleted → deleted.
    const merged = prev?.event === 'object.created' && event === 'object.updated' ? 'object.created' : event;
    q.pending.delete(key);
    q.pending.set(key, { event: merged, object_type: payload.objectType, id: payload.id });
    schedule(integration.id, q);
  }
}

function schedule(id: string, q: Queue) {
  if (q.timer || q.sending || !q.pending.size) return;
  // A full interval gathers a burst; since `lastSentAt` is set when a delivery ends, requests are an interval apart.
  q.timer = setTimeout(() => void flush(id, q), options.intervalMs);
  q.timer.unref?.();
}

async function flush(id: string, q: Queue) {
  q.timer = null;
  const integration = activeFlowIntegrationById(id);
  if (!integration) {
    queues.delete(id);
    return;
  }
  const events = [...q.pending.values()].slice(0, MAX_BATCH);
  for (const e of events) q.pending.delete(`${e.object_type}:${e.id}`);
  q.sending = true;
  try {
    const delivery = await deliver(id, integration.flowUrl!, events);
    try {
      recordActivity(id, { lastDelivery: delivery });
    } catch {
      /* integration deleted meanwhile */
    }
  } finally {
    q.sending = false;
    q.lastSentAt = Date.now();
    schedule(id, q);
  }
}

const activeFlowIntegrationById = (id: string) => {
  try {
    return activeFlowIntegrations().find((i) => i.id === id) ?? null;
  } catch {
    return null;
  }
};

/** Signs and POSTs one batch, retrying with backoff; never throws. */
export async function deliver(integrationId: string, flowUrl: string, events: FlowHookEvent[]): Promise<FlowDelivery> {
  let attempts = 0;
  let last: Pick<FlowDelivery, 'ok' | 'httpStatus' | 'error'> = { ok: false, httpStatus: null, error: null };
  for (;;) {
    attempts++;
    last = await attempt(integrationId, flowUrl, events);
    // 4xx other than 408/429 won't get better by retrying (bad signature, unknown integration).
    const retryable = !last.ok && (last.httpStatus == null || last.httpStatus >= 500 || last.httpStatus === 408 || last.httpStatus === 429);
    if (last.ok || !retryable || attempts > options.retryDelaysMs.length) break;
    // Re-check between attempts: the integration may have been deactivated or deleted.
    await sleep(Math.max(options.retryDelaysMs[attempts - 1], options.intervalMs));
    if (!activeFlowIntegrationById(integrationId)) break;
  }
  return { at: new Date().toISOString(), ...last, events: events.length, attempts };
}

async function attempt(integrationId: string, flowUrl: string, events: FlowHookEvent[]) {
  try {
    const body: FlowHookBody = { integration_id: integrationId, events, sent_at: new Date().toISOString() };
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = (await signingSecrets(integrationId)).map((s) => sign(s, ts, raw)).join(',');
    const res = await fetch(`${flowUrl}/api/integrations/inventory-db/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inventory-timestamp': ts, 'x-inventory-signature': signature },
      body: raw,
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: 'error',
    });
    await res.arrayBuffer().catch(() => undefined);
    return { ok: res.ok, httpStatus: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    const e = err as Error;
    return { ok: false, httpStatus: null, error: e.name === 'TimeoutError' ? 'Timed out' : e.message || 'Network error' };
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/** Subscribes to DCIM/IPAM change events once per process. */
export function startFlowNotifier() {
  if (listening) return;
  listening = true;
  for (const event of ['object.created', 'object.updated', 'object.deleted'] as const) {
    netboxEvents.on(event, (payload) => enqueue(event, payload));
  }
}

/** Tests: drops queued events and timers. */
export function resetFlowNotifier() {
  for (const q of queues.values()) if (q.timer) clearTimeout(q.timer);
  queues.clear();
}
