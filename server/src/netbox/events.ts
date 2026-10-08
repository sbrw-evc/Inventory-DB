import { EventEmitter } from 'node:events';
import type { Obj } from './types.js';

export interface NetboxEventPayload {
  /** e.g. `dcim.device` */
  objectType: string;
  id: number;
  /** Serialized object (post-change; the pre-change snapshot for deletes). */
  data: Obj;
  userId: string | null;
}

export interface NetboxEvents {
  'object.created': [NetboxEventPayload];
  'object.updated': [NetboxEventPayload];
  'object.deleted': [NetboxEventPayload];
}

/** Emitted after a DCIM/IPAM write commits. Integrations (Umbrella CMDB sync) and webhooks subscribe here. */
export const netboxEvents = new EventEmitter<NetboxEvents>();
netboxEvents.setMaxListeners(50);
