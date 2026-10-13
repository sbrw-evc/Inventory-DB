import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  FlowPrefixAddress,
  FlowPrefixAddressesResponse,
  FlowStatusResponse,
  Integration,
  InventoryObjectType,
  UmbrellaCiFeed,
} from '../../../shared/src/index.js';
import { requireUser } from '../auth/plugin.js';
import { getUser, issueJwt } from '../auth/service.js';
import { HttpError, notFound, unauthorized } from '../errors.js';
import { getDb } from '../db/index.js';
import { authHeaders, dcimClientFor } from '../integrations/dcim.js';
import { clearFlowCache, FlowError, flowGet } from '../integrations/flow/client.js';
import { ensureSnmpIndexField } from '../integrations/flow/customField.js';
import { startFlowNotifier } from '../integrations/flow/notifier.js';
import { getNetboxRole, requireNetboxRole } from '../netbox/access.js';
import { cidrToString, hexKey, parseCidr, parseIp } from '../netbox/cidr.js';
import { verifySignature } from '../integrations/secrets.js';
import {
  activeFlowIntegrations,
  createIntegration,
  deleteIntegration,
  getIntegration,
  getOwnedIntegration,
  getSecret,
  listIntegrations,
  recordActivity,
  rotateSecret,
  updateIntegration,
} from '../integrations/store.js';
import {
  alertHistory,
  buildIdentityIndex,
  listUnmatched,
  matchTargets,
  monitoringStatus,
  recordAlert,
  type IdentityIndex,
} from '../integrations/umbrella/alerts.js';
import { buildCis } from '../integrations/umbrella/ci.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const url = z.string().url().nullable().optional();
const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');
const umbrellaSchema = z.object({
  kind: z.literal('umbrella'),
  title: z.string().trim().min(1).max(200),
  active: z.boolean().optional(),
  umbrellaUrl: url,
  inventoryUrl: url,
});
const flowSchema = z.object({
  kind: z.literal('flow'),
  title: z.string().trim().min(1).max(200),
  active: z.boolean().optional(),
  flowUrl: httpUrl,
  flowToken: z.string().trim().min(1).max(4096),
});
const createSchema = z.discriminatedUnion('kind', [umbrellaSchema, flowSchema]);
const patchSchema = umbrellaSchema
  .omit({ kind: true })
  .extend({ flowUrl: httpUrl.optional(), flowToken: z.string().trim().min(1).max(4096).optional() })
  .partial();

const flowObjectType = z.enum(['dcim.device', 'dcim.interface', 'circuits.circuit']);
const flowWindow = z
  .string()
  .regex(/^\d{1,3}[mhd]$/)
  .optional();
const idList = z
  .string()
  .regex(/^\d+(,\d+)*$/)
  .transform((s) => [...new Set(s.split(',').map(Number))]);

const objectType = z.enum(['dcim.site', 'dcim.rack', 'dcim.device']);

const alertSchema = z.object({
  alert_id: z.string().min(1).max(200),
  status: z.enum(['open', 'acknowledged', 'resolved', 'closed']),
  severity: z.enum(['critical', 'error', 'warning', 'info']),
  title: z.string().max(1000),
  signal: z.string().max(200).optional(),
  ci: z.object({
    source_refs: z.array(z.string()).optional(),
    name: z.string().optional(),
    identities: z
      .object({ hostname: z.string().optional(), fqdn: z.string().optional(), ip: z.union([z.string(), z.array(z.string())]).optional() })
      .optional(),
  }),
  links: z.object({ incident: z.string().url().optional(), grafana: z.string().url().optional() }).optional(),
  // Normalised so stored timestamps compare as strings.
  updated_at: z
    .string()
    .datetime({ offset: true })
    .transform((s) => new Date(s).toISOString())
    .optional(),
});

const IDENTITY_TTL_MS = 60_000;

export async function integrationRoutes(app: FastifyInstance) {
  // Keep the exact bytes for HMAC verification; scoped to this plugin's routes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body === '' ? undefined : JSON.parse(body as string));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  startFlowNotifier();

  const isAdmin = (req: FastifyRequest) => getNetboxRole(requireUser(req).id) === 'admin';
  const owned = (req: FastifyRequest) => getOwnedIntegration((req.params as { id: string }).id, requireUser(req).id, isAdmin(req));

  app.get('/api/v1/integrations', async (req) => listIntegrations(requireUser(req).id, isAdmin(req)));

  app.post('/api/v1/integrations', async (req, reply) => {
    const user = requireUser(req);
    const input = createSchema.parse(req.body);
    if (input.kind === 'flow') {
      // A Flow integration changes what every user sees on DCIM pages and makes the server call Flow: admins only
      // (every DCIM/IPAM admin manages it, see getOwnedIntegration).
      requireNetboxRole(req, 'admin');
    }
    const created = await createIntegration(user.id, input);
    if (input.kind === 'flow') ensureSnmpIndexField(user.id);
    reply.status(201);
    return created;
  });

  app.get('/api/v1/integrations/:id', async (req) => owned(req));

  app.patch('/api/v1/integrations/:id', async (req) => {
    const integration = owned(req);
    const updated = await updateIntegration(integration.id, patchSchema.parse(req.body ?? {}));
    if (integration.kind === 'flow') clearFlowCache();
    return updated;
  });

  app.delete('/api/v1/integrations/:id', async (req) => {
    const integration = owned(req);
    await deleteIntegration(integration.id);
    identityCache.delete(integration.id);
    if (integration.kind === 'flow') clearFlowCache();
    return { ok: true };
  });

  app.post('/api/v1/integrations/:id/rotate-secret', async (req) => ({ secret: await rotateSecret(owned(req).id) }));

  app.get('/api/v1/integrations/:id/umbrella/unmatched', async (req) => listUnmatched(owned(req).id));

  /**
   * CMDB feed for Umbrella's inventory connector: a full snapshot of sites, racks and devices as CIs.
   * Umbrella's CMDB Discovery diffs consecutive snapshots itself, so no change cursor is needed.
   */
  app.get('/api/v1/integrations/:id/umbrella/ci', async (req): Promise<UmbrellaCiFeed> => {
    requireUser(req);
    const integration = getIntegration((req.params as { id: string }).id);
    if (!integration.active || integration.kind !== 'umbrella') throw notFound('Integration');
    const query = z
      .object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(5000).default(1000) })
      .parse(req.query);
    const baseUrl = (integration.inventoryUrl ?? `${req.protocol}://${req.host}`).replace(/\/+$/, '');
    const all = await buildCis(dcimClientFor(app, authHeaders(req)), baseUrl);
    const items = all.slice(query.offset, query.offset + query.limit);
    const next = query.offset + items.length;
    if (next >= all.length) recordActivity(integration.id, { lastFeedAt: new Date().toISOString(), lastFeedCount: all.length });
    return {
      source: 'inventory-db',
      integration_id: integration.id,
      generated_at: new Date().toISOString(),
      count: all.length,
      offset: query.offset,
      next_offset: next < all.length ? next : null,
      items,
    };
  });

  /** Alert state changes from Umbrella, signed with the integration secret (no user token). */
  app.post('/api/v1/integrations/:id/umbrella/alerts', async (req, reply) => {
    const { id } = req.params as { id: string };
    let integration;
    try {
      integration = getIntegration(id);
    } catch {
      throw unauthorized('Invalid signature');
    }
    const ok =
      integration.active &&
      integration.kind === 'umbrella' &&
      verifySignature(
        await getSecret(id),
        req.headers['x-umbrella-timestamp'] as string | undefined,
        req.headers['x-umbrella-signature'] as string | undefined,
        req.rawBody ?? '',
      );
    // Same answer for unknown, inactive and badly signed so ids can't be probed.
    if (!ok) throw unauthorized('Invalid signature');

    const body = req.body as unknown;
    const events = z.array(alertSchema).max(500).parse(Array.isArray(body) ? body : [body]);
    let index: IdentityIndex | undefined;
    const needsIndex = events.some((e) => !e.ci.source_refs?.length);
    if (needsIndex) index = await identityIndex(app, id, integration.createdBy);
    const results = events.map((event) => {
      const targets = matchTargets(event.ci, () => index!);
      recordAlert(id, event, targets);
      return { alert_id: event.alert_id, matched: targets.map((t) => `${t.type}:${t.id}`) };
    });
    recordActivity(id, { lastAlertAt: new Date().toISOString() });
    reply.status(202);
    return { results };
  });

  /** Monitoring state of inventory objects, for status chips in lists and the record side panel. */
  app.get('/api/v1/integrations/umbrella/status', async (req) => {
    requireUser(req);
    const q = z
      .object({
        object_type: objectType.default('dcim.device'),
        ids: z
          .string()
          .regex(/^\d+(,\d+)*$/)
          .transform((s) => s.split(',').map(Number))
          .optional(),
      })
      .parse(req.query);
    if (q.ids && q.ids.length > 1000) throw new HttpError(400, 'BAD_REQUEST', 'At most 1000 ids per request');
    return monitoringStatus(q.object_type, q.ids);
  });

  /**
   * Traffic of DCIM objects from Umbrella Flow (contract §2.1), for the Traffic columns, chips and sparklines.
   * Any signed-in user with DCIM/IPAM read access may call it; Inventory DB calls Flow with the integration's token.
   * 404 when no Flow integration is active (the UI then hides the traffic), 502 when Flow fails.
   */
  app.get('/api/v1/integrations/flow/status', async (req): Promise<FlowStatusResponse> => {
    requireNetboxRole(req, 'viewer');
    const q = z.object({ object_type: flowObjectType, ids: idList, window: flowWindow }).parse(req.query);
    if (q.ids.length > 1000) throw new HttpError(400, 'BAD_REQUEST', 'At most 1000 ids per request');
    const integration = activeFlow();
    const res = await flowGet<FlowStatusResponse>(integration, '/api/integrations/inventory-db/status', {
      object_type: q.object_type,
      ids: [...q.ids].sort((a, b) => a - b).join(','),
      window: q.window,
    });
    if (!res || typeof res !== 'object' || typeof res.results !== 'object' || !res.results) throw new FlowError(502, 'Umbrella Flow sent an invalid response');
    // Only the ids asked for (the cached answer may be shared by an equal query).
    const results: FlowStatusResponse['results'] = {};
    for (const id of q.ids) if (res.results[id]) results[id] = res.results[id];
    return { window: res.window ?? q.window ?? '24h', results };
  });

  /** Addresses Flow saw inside a prefix, with whether each one is in IPAM (checked here, so it is current). */
  app.get('/api/v1/integrations/flow/prefix-addresses', async (req): Promise<FlowPrefixAddressesResponse> => {
    requireNetboxRole(req, 'viewer');
    const q = z
      .object({
        prefix: z.string().refine((p) => !!parseCidr(p), 'Expected a prefix like 10.0.0.0/24'),
        vrf: z.string().max(100).optional(),
        window: flowWindow,
      })
      .parse(req.query);
    const prefix = cidrToString(parseCidr(q.prefix)!);
    const integration = activeFlow();
    const res = await flowGet<{ prefix?: string; results?: unknown }>(integration, '/api/integrations/inventory-db/prefix-addresses', {
      prefix,
      vrf: q.vrf,
      window: q.window,
    });
    if (!res || !Array.isArray(res.results)) throw new FlowError(502, 'Umbrella Flow sent an invalid response');
    return { prefix, results: markInIpam(res.results as FlowPrefixAddress[], q.vrf) };
  });

  app.get('/api/v1/integrations/umbrella/status/:objectType/:objectId', async (req) => {
    requireUser(req);
    const p = z.object({ objectType, objectId: z.coerce.number().int() }).parse(req.params);
    const [status] = monitoringStatus(p.objectType as InventoryObjectType, [p.objectId]);
    return { ...status, history: alertHistory(p.objectType, p.objectId) };
  });
}

/** The Flow integration that answers traffic queries: the oldest active one. */
function activeFlow(): Integration {
  const [integration] = activeFlowIntegrations();
  if (!integration) throw notFound('Flow integration');
  return integration;
}

/** Sets `in_ipam` / `ip_address_id` from this inventory's IPAM (in the given VRF by name, else in any VRF). */
function markInIpam(rows: FlowPrefixAddress[], vrfName?: string): FlowPrefixAddress[] {
  const parsed = rows
    .filter((r) => r && typeof r.address === 'string')
    .slice(0, 1024)
    .map((r) => ({ row: r, ip: parseIp(r.address.split('/')[0]) }));
  const keys = parsed.filter((p) => p.ip).map((p) => `${p.ip!.family}:${hexKey(p.ip!.value)}`);
  const found = new Map<string, number>();
  if (keys.length) {
    const db = getDb();
    const vrf = vrfName ? (db.prepare('SELECT id FROM nb_vrfs WHERE name = ?').get(vrfName) as { id: number } | undefined) : undefined;
    const hexes = [...new Set(parsed.filter((p) => p.ip).map((p) => hexKey(p.ip!.value)))];
    const rowsInIpam = db
      .prepare(
        `SELECT id, family, host_hex FROM nb_ip_addresses WHERE host_hex IN (${hexes.map(() => '?').join(',')})${vrf ? ' AND vrf_id = ?' : ''} ORDER BY id`,
      )
      .all(...hexes, ...(vrf ? [vrf.id] : [])) as { id: number; family: number; host_hex: string }[];
    for (const r of rowsInIpam) {
      const key = `${r.family}:${r.host_hex}`;
      if (!found.has(key)) found.set(key, r.id);
    }
  }
  return parsed.map(({ row, ip }) => {
    const id = ip ? found.get(`${ip.family}:${hexKey(ip.value)}`) : undefined;
    return {
      address: row.address,
      bytes: Number(row.bytes) || 0,
      flows: Number(row.flows) || 0,
      last_seen: row.last_seen ?? null,
      in_ipam: id != null,
      ip_address_id: id ?? null,
    };
  });
}

const identityCache = new Map<string, { at: number; index: Promise<IdentityIndex> }>();

/** Identity index of the inventory as the integration's owner sees it, cached briefly. */
function identityIndex(app: FastifyInstance, integrationId: string, ownerId: string): Promise<IdentityIndex> {
  const hit = identityCache.get(integrationId);
  if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.index;
  const index = (async () => {
    const token = await issueJwt(getUser(ownerId));
    return buildIdentityIndex(await buildCis(dcimClientFor(app, { authorization: `Bearer ${token}` }), ''));
  })();
  identityCache.set(integrationId, { at: Date.now(), index });
  index.catch(() => identityCache.delete(integrationId));
  return index;
}

/** Tests. */
export const clearIdentityCache = () => identityCache.clear();
