import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { InventoryObjectType, UmbrellaCiFeed } from '../../../shared/src/index.js';
import { requireUser } from '../auth/plugin.js';
import { getUser, issueJwt } from '../auth/service.js';
import { HttpError, notFound, unauthorized } from '../errors.js';
import { authHeaders, dcimClientFor } from '../integrations/dcim.js';
import { verifySignature } from '../integrations/secrets.js';
import {
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
const createSchema = z.object({
  kind: z.literal('umbrella'),
  title: z.string().trim().min(1).max(200),
  active: z.boolean().optional(),
  umbrellaUrl: url,
  inventoryUrl: url,
});
const patchSchema = createSchema.omit({ kind: true }).partial();

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

  const owned = (req: FastifyRequest) => getOwnedIntegration((req.params as { id: string }).id, requireUser(req).id);

  app.get('/api/v1/integrations', async (req) => listIntegrations(requireUser(req).id));

  app.post('/api/v1/integrations', async (req, reply) => {
    const user = requireUser(req);
    const created = await createIntegration(user.id, createSchema.parse(req.body));
    reply.status(201);
    return created;
  });

  app.get('/api/v1/integrations/:id', async (req) => owned(req));

  app.patch('/api/v1/integrations/:id', async (req) => updateIntegration(owned(req).id, patchSchema.parse(req.body ?? {})));

  app.delete('/api/v1/integrations/:id', async (req) => {
    await deleteIntegration(owned(req).id);
    identityCache.delete((req.params as { id: string }).id);
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
    if (!integration.active) throw notFound('Integration');
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

  app.get('/api/v1/integrations/umbrella/status/:objectType/:objectId', async (req) => {
    requireUser(req);
    const p = z.object({ objectType, objectId: z.coerce.number().int() }).parse(req.params);
    const [status] = monitoringStatus(p.objectType as InventoryObjectType, [p.objectId]);
    return { ...status, history: alertHistory(p.objectType, p.objectId) };
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
