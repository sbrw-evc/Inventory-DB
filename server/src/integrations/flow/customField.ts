import { getUser } from '../../auth/service.js';
import { getDb } from '../../db/index.js';
import { createCtx } from '../../netbox/engine.js';
import { netboxEvents } from '../../netbox/events.js';
import { ensureNetboxSchema } from '../../netbox/schema.js';

export const SNMP_INDEX_FIELD = 'snmp_index';

/**
 * Flow matches interfaces to its flow exporters' ifIndex through the `snmp_index` custom field (contract §2.3).
 * Created when a `flow` integration is created, unless a custom field of that name exists already.
 * Returns true when it was created.
 */
export function ensureSnmpIndexField(userId: string): boolean {
  const db = getDb();
  ensureNetboxSchema(db);
  if (db.prepare('SELECT 1 FROM nb_custom_fields WHERE name = ?').get(SNMP_INDEX_FIELD)) return false;
  const ctx = createCtx(db, getUser(userId));
  db.transaction(() =>
    ctx.create('extras.customfield', {
      name: SNMP_INDEX_FIELD,
      label: 'SNMP index',
      type: 'integer',
      object_types: ['dcim.interface'],
      description: 'ifIndex of the interface, used by Umbrella Flow to match flow records',
      validation_minimum: 0,
    }),
  )();
  for (const e of ctx.events) netboxEvents.emit(e.event, { objectType: e.objectType, id: e.id, data: e.data, userId });
  return true;
}
