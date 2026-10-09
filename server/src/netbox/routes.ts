import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/index.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { bootstrapAdmin, getNetboxRole, listRoles, requireNetboxRole, setRole, type NetboxRole } from './access.js';
import { requireUser } from '../auth/plugin.js';
import { formatIp } from './cidr.js';
import { importCsv } from './csvImport.js';
import { serializeTrace, tracePath, TERMINATION_TYPES } from './cabling.js';
import { rackElevation } from './dcim.js';
import { rackPower } from './power.js';
import { createCtx, createObject, deleteObject, getRowOr404, nestedRef, serialize, updateObject } from './engine.js';
import { netboxEvents } from './events.js';
import { availableIps, availablePrefixes, nextAvailablePrefix, prefixCidr } from './ipam.js';
import { listRows, pageLinks, type Query } from './query.js';
import { hasCustomFields, isTaggable, modelByType, models, resolveModel } from './registry.js';
import { ensureNetboxSchema } from './schema.js';
import { colOf, type Ctx, type ModelDef, type Obj, type Row } from './types.js';

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Query; Body: unknown }>;

/** Runs a handler with a request context; writes run in one transaction and emit events after commit. */
function run<T>(req: FastifyRequest, min: NetboxRole, fn: (ctx: Ctx) => T): T {
  const { user } = requireNetboxRole(req, min);
  const ctx = createCtx(getDb(), user);
  const result = min === 'viewer' ? fn(ctx) : ctx.db.transaction(() => fn(ctx))();
  for (const e of ctx.events) {
    try {
      netboxEvents.emit(e.event, { objectType: e.objectType, id: e.id, data: e.data, userId: user.id });
    } catch (err) {
      req.log.error(err);
    }
  }
  return result;
}

const asList = (body: unknown): unknown[] | null => (Array.isArray(body) ? body : null);
const objBody = (b: unknown) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw badRequest('Expected a JSON object');
  return b as Record<string, unknown>;
};

function idsFromBody(body: unknown): number[] {
  const raw = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as { ids?: unknown }).ids) ? (body as { ids: unknown[] }).ids : null;
  if (!raw) throw badRequest('Expected a list of objects with "id" (or {"ids": [...]})');
  return raw.map((x) => Number(typeof x === 'object' && x ? (x as { id?: unknown }).id : x));
}

function listResponse(req: Req, ctx: Ctx, m: ModelDef) {
  const { count, rows, limit, offset } = listRows(ctx, m, req.query);
  const brief = ['true', '1'].includes(String(req.query.brief ?? ''));
  return {
    count,
    ...pageLinks(req.url, count, limit, offset),
    results: rows.map((r) => (brief ? nestedRef(ctx, m.type, r.id) : serialize(ctx, m, r))),
  };
}

function registerModel(app: FastifyInstance, m: ModelDef) {
  const base = `/api/v1/${m.app}/${m.path}`;
  app.get(base, async (req: Req) => run(req, 'viewer', (ctx) => listResponse(req, ctx, m)));
  app.get(`${base}/:id`, async (req: Req) => run(req, 'viewer', (ctx) => serialize(ctx, m, getRowOr404(ctx, m, req.params.id))));
  if (m.readOnlyModel) return;

  app.post(base, async (req: Req, reply: FastifyReply) => {
    const out = run(req, 'editor', (ctx) => {
      const list = asList(req.body);
      if (list) return list.map((b) => serialize(ctx, m, createObject(ctx, m, objBody(b))));
      return serialize(ctx, m, createObject(ctx, m, objBody(req.body)));
    });
    return reply.status(201).send(out);
  });
  const bulkUpdate = async (req: Req) =>
    run(req, 'editor', (ctx) => {
      const list = asList(req.body);
      if (!list) throw badRequest('Expected a list of objects with "id"');
      return list.map((b) => {
        const body = objBody(b);
        return serialize(ctx, m, updateObject(ctx, m, Number(body.id), body));
      });
    });
  app.patch(base, bulkUpdate);
  app.put(base, bulkUpdate);
  app.delete(base, async (req: Req, reply: FastifyReply) => {
    run(req, 'editor', (ctx) => idsFromBody(req.body).forEach((id) => deleteObject(ctx, m, id)));
    return reply.status(204).send();
  });
  const update = async (req: Req) => run(req, 'editor', (ctx) => serialize(ctx, m, updateObject(ctx, m, Number(req.params.id), objBody(req.body))));
  app.patch(`${base}/:id`, update);
  app.put(`${base}/:id`, update);
  app.delete(`${base}/:id`, async (req: Req, reply: FastifyReply) => {
    run(req, 'editor', (ctx) => deleteObject(ctx, m, Number(req.params.id)));
    return reply.status(204).send();
  });
}

const M = (type: string) => modelByType(type)!;

/** Body for allocation endpoints: one object or a list of objects. */
const allocationBodies = (body: unknown): { many: boolean; items: Record<string, unknown>[] } => {
  if (Array.isArray(body)) return { many: true, items: body.map(objBody) };
  return { many: false, items: [body == null ? {} : objBody(body)] };
};

function schemaInfo() {
  return models.map((m) => ({
    object_type: m.type,
    app: m.app,
    path: m.path,
    url: `/api/v1/${m.app}/${m.path}/`,
    verbose_name: m.verbose,
    verbose_name_plural: m.verbosePlural,
    read_only: !!m.readOnlyModel,
    taggable: isTaggable(m),
    custom_fields: hasCustomFields(m),
    brief: m.brief,
    ordering: m.ordering,
    filters: Object.keys(m.filters ?? {}),
    write_extras: m.writeExtras ?? [],
    fields: m.fields.map((f) => ({
      name: f.name,
      kind: f.kind,
      required: !!f.required,
      read_only: !!f.readOnly,
      default: f.default ?? null,
      ref: f.ref ?? null,
      choices: f.choices?.map(([value, label]) => ({ value, label })) ?? (f.intChoices ? f.intChoices.map((v) => ({ value: v, label: String(v) })) : null),
      max_length: f.maxLength ?? null,
      min: f.min ?? null,
      max: f.max ?? null,
      column: colOf(f),
    })),
  }));
}

export async function registerNetboxRoutes(app: FastifyInstance) {
  ensureNetboxSchema(getDb());
  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  for (const m of models) registerModel(app, m);

  // Changelog alias
  app.get('/api/v1/extras/changelog', async (req: Req) => run(req, 'viewer', (ctx) => listResponse(req, ctx, M('extras.objectchange'))));

  // Rack elevation
  app.get('/api/v1/dcim/racks/:id/elevation', async (req: Req) =>
    run(req, 'viewer', (ctx) => {
      const rack = getRowOr404(ctx, M('dcim.rack'), req.params.id);
      const face = String(req.query.face ?? 'front');
      if (face !== 'front' && face !== 'rear') throw badRequest('face must be front or rear', { face: ['Must be front or rear.'] });
      const units = rackElevation(ctx, rack, face);
      return { count: units.length, next: null, previous: null, results: units };
    }),
  );

  // Rack power summary
  app.get('/api/v1/dcim/racks/:id/power', async (req: Req) => run(req, 'viewer', (ctx) => rackPower(ctx, getRowOr404(ctx, M('dcim.rack'), req.params.id).id)));

  // Cable trace (and NetBox's `paths` alias for pass-through ports) on every cable termination type
  for (const type of Object.keys(TERMINATION_TYPES)) {
    const m = M(type);
    const handler = async (req: Req) => run(req, 'viewer', (ctx) => serializeTrace(ctx, tracePath(ctx, type, getRowOr404(ctx, m, req.params.id))));
    app.get(`/api/v1/${m.app}/${m.path}/:id/trace`, handler);
    if (['dcim.frontport', 'dcim.rearport', 'circuits.circuittermination'].includes(type)) app.get(`/api/v1/${m.app}/${m.path}/:id/paths`, handler);
  }

  // Available prefixes
  app.get('/api/v1/ipam/prefixes/:id/available-prefixes', async (req: Req) =>
    run(req, 'viewer', (ctx) => {
      const p = getRowOr404(ctx, M('ipam.prefix'), req.params.id);
      const vrf = nestedRef(ctx, 'ipam.vrf', p.vrf_id);
      return availablePrefixes(ctx, p).map((c) => ({ family: c.family, prefix: `${formatIp(c.network, c.family)}/${c.prefixLength}`, vrf }));
    }),
  );
  app.post('/api/v1/ipam/prefixes/:id/available-prefixes', async (req: Req, reply: FastifyReply) => {
    const out = run(req, 'editor', (ctx) => {
      const p = getRowOr404(ctx, M('ipam.prefix'), req.params.id);
      const { many, items } = allocationBodies(req.body);
      const taken: ReturnType<typeof prefixCidr>[] = [];
      const created = items.map((item, i) => {
        const len = Number(item.prefix_length);
        if (!Number.isInteger(len)) throw badRequest('Validation failed', { prefix_length: ['This field is required.'] });
        const next = nextAvailablePrefix(ctx, p, len, taken);
        if (!next) throw conflict(`Insufficient space is available to accommodate the requested prefix size(s) (item ${i + 1}: /${len})`);
        taken.push(next);
        const { prefix_length: _drop, ...rest } = item;
        return serialize(ctx, M('ipam.prefix'), createObject(ctx, M('ipam.prefix'), { vrf: p.vrf_id, ...rest, prefix: `${formatIp(next.network, next.family)}/${len}` }));
      });
      return many ? created : created[0];
    });
    return reply.status(201).send(out);
  });

  // Available IPs (prefix or IP range)
  const ipLimit = (req: Req) => Math.min(1000, Math.max(1, Number(req.query.limit ?? 50) || 50));
  const parentFor = (ctx: Ctx, kind: 'prefixes' | 'ip-ranges', id: string): { p: Row; range?: { start: bigint; end: bigint } } => {
    if (kind === 'prefixes') return { p: getRowOr404(ctx, M('ipam.prefix'), id) };
    const r = getRowOr404(ctx, M('ipam.iprange'), id);
    return {
      p: { ...r, prefix: `${r.start_address.split('/')[0]}/${r.prefix_length}`, status: 'active', is_pool: true },
      range: { start: BigInt(`0x${r.start_hex}`), end: BigInt(`0x${r.end_hex}`) },
    };
  };
  for (const kind of ['prefixes', 'ip-ranges'] as const) {
    app.get(`/api/v1/ipam/${kind}/:id/available-ips`, async (req: Req) =>
      run(req, 'viewer', (ctx) => {
        const { p, range } = parentFor(ctx, kind, req.params.id);
        const vrf = nestedRef(ctx, 'ipam.vrf', p.vrf_id);
        return availableIps(ctx, p, ipLimit(req), range).map((v) => ({ family: p.family, address: `${formatIp(v, p.family)}/${p.prefix_length}`, vrf }));
      }),
    );
    app.post(`/api/v1/ipam/${kind}/:id/available-ips`, async (req: Req, reply: FastifyReply) => {
      const out = run(req, 'editor', (ctx) => {
        const { p, range } = parentFor(ctx, kind, req.params.id);
        const { many, items } = allocationBodies(req.body);
        const free = availableIps(ctx, p, items.length, range);
        if (free.length < items.length) throw conflict(`Insufficient space is available to accommodate the requested number of IPs (${items.length})`);
        const created = items.map((item, i) =>
          serialize(ctx, M('ipam.ipaddress'), createObject(ctx, M('ipam.ipaddress'), { vrf: p.vrf_id, ...item, address: `${formatIp(free[i], p.family)}/${p.prefix_length}` })),
        );
        return many ? created : created[0];
      });
      return reply.status(201).send(out);
    });
  }

  // Roles
  app.get('/api/v1/netbox/me', async (req) => {
    const user = requireUser(req);
    bootstrapAdmin(user); // the first caller becomes admin while there is none
    const role = getNetboxRole(user.id);
    return { user, role, can_write: role !== 'viewer', is_admin: role === 'admin' };
  });
  app.get('/api/v1/netbox/roles', async (req) => {
    requireNetboxRole(req, 'admin');
    return { results: listRoles() };
  });
  app.post('/api/v1/netbox/roles', async (req: Req) => {
    requireNetboxRole(req, 'admin');
    const body = objBody(req.body);
    const who = String(body.user_id ?? body.email ?? '');
    if (!who) throw badRequest('Validation failed', { user_id: ['Provide user_id or email.'] });
    return setRole(who, String(body.role));
  });
  app.put('/api/v1/netbox/roles/:userId', async (req: Req) => {
    requireNetboxRole(req, 'admin');
    return setRole(req.params.userId, String(objBody(req.body).role));
  });

  // Schema (models, fields, choices) for clients and the UI
  app.get('/api/v1/netbox/schema', async (req) => {
    requireNetboxRole(req, 'viewer');
    return { results: schemaInfo() };
  });

  // Global search
  app.get('/api/v1/netbox/search', async (req: Req) =>
    run(req, 'viewer', (ctx) => {
      const text = String(req.query.q ?? '').trim();
      if (!text) return { count: 0, results: [] };
      const per = Math.min(50, Math.max(1, Number(req.query.limit ?? 10) || 10));
      const types = req.query.object_type ? String(req.query.object_type).split(',') : null;
      const results: Obj[] = [];
      for (const m of models) {
        if (m.readOnlyModel || m.type === 'extras.customfield' || m.type.endsWith('template')) continue;
        if (types && !types.includes(m.type)) continue;
        const { rows } = listRows(ctx, m, { q: text, limit: String(per) });
        for (const r of rows) {
          results.push({ object_type: m.type, object_type_label: m.verbose, ...nestedRef(ctx, m.type, r.id), display_url: `/${m.app}/${m.path}/${r.id}` });
        }
      }
      return { count: results.length, results };
    }),
  );

  // CSV import
  app.post('/api/v1/netbox/import/:objectType', async (req: Req, reply: FastifyReply) => {
    const m = resolveModel(req.params.objectType);
    if (!m) throw notFound('Object type');
    const text = typeof req.body === 'string' ? req.body : req.body && typeof req.body === 'object' ? (req.body as { csv?: unknown }).csv : null;
    if (typeof text !== 'string') throw badRequest('Send CSV text (Content-Type: text/csv) or {"csv": "..."}');
    const created = run(req, 'editor', (ctx) => importCsv(ctx, m, text));
    return reply.status(201).send({ created: created.length, results: created });
  });
}

