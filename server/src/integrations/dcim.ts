import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../errors.js';

/**
 * Read access to DCIM/IPAM objects. The integration only uses the public NetBox-compatible REST API
 * (`/api/v1/dcim/...`, `/api/v1/ipam/...`) with the caller's own credentials, so it sees exactly what
 * the caller may see and does not depend on how DCIM stores its data.
 */
export interface DcimClient {
  /** All objects of a list endpoint, following NetBox `limit`/`offset` paging. */
  list<T = NetboxObject>(path: string, query?: Record<string, string>): Promise<T[]>;
}

export type NetboxObject = Record<string, any> & { id: number };

interface NetboxPage {
  count?: number;
  next?: string | null;
  results: NetboxObject[];
}

const PAGE = 1000;

/** Forwards the caller's auth headers to the DCIM API through `app.inject` (no network hop). */
export function injectDcimClient(app: FastifyInstance, headers: Record<string, string>): DcimClient {
  return {
    async list<T>(path: string, query: Record<string, string> = {}) {
      const out: NetboxObject[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const qs = new URLSearchParams({ ...query, limit: String(PAGE), offset: String(offset) });
        let res = await app.inject({ method: 'GET', url: `/api/v1/${path}/?${qs}`, headers });
        // Accept the API with or without NetBox's trailing slash.
        if (res.statusCode === 404) res = await app.inject({ method: 'GET', url: `/api/v1/${path}?${qs}`, headers });
        if (res.statusCode === 404) throw new HttpError(503, 'DCIM_UNAVAILABLE', `DCIM API /api/v1/${path} is not available`);
        if (res.statusCode >= 400) {
          const body = res.json() as { error?: string; message?: string };
          throw new HttpError(res.statusCode, body.error ?? 'UPSTREAM', body.message ?? `GET /api/v1/${path} failed`);
        }
        const body = res.json() as NetboxPage | NetboxObject[];
        const results = Array.isArray(body) ? body : body.results;
        out.push(...results);
        if (Array.isArray(body) || !body.next || results.length < PAGE) break;
      }
      return out as T[];
    },
  };
}

let override: DcimClient | null = null;

/** Tests (and an in-process DCIM service, if one is ever preferred) can replace the client. */
export function setDcimClient(client: DcimClient | null) {
  override = client;
}

export const dcimClientFor = (app: FastifyInstance, headers: Record<string, string>): DcimClient =>
  override ?? injectDcimClient(app, headers);

/** The caller's credentials, to forward to the DCIM API. */
export function authHeaders(req: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of ['authorization', 'xc-auth', 'xc-token'] as const) {
    const v = req.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }
  return headers;
}
