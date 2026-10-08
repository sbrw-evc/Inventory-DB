import type { FastifyInstance } from 'fastify';
import { registerNetboxRoutes } from '../netbox/routes.js';

/** DCIM/IPAM (NetBox core): /api/v1/dcim, /api/v1/ipam, /api/v1/tenancy, /api/v1/extras, /api/v1/netbox. */
export async function netboxRoutes(app: FastifyInstance) {
  await registerNetboxRoutes(app);
}
