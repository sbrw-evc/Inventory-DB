import { EventEmitter } from 'node:events';
import type { RecordData } from '../../shared/src/index.js';

export interface RecordEventContext {
  baseId: string;
  tableId: string;
  userId?: string | null;
}

/**
 * Emitted by the data engine after a write commits. Platform features (webhooks, audit) subscribe here
 * rather than being called by the data engine directly.
 */
export interface AppEvents {
  'record.insert': [ctx: RecordEventContext, records: RecordData[]];
  'record.update': [ctx: RecordEventContext, changes: { before: RecordData; after: RecordData }[]];
  'record.delete': [ctx: RecordEventContext, records: RecordData[]];
  'record.link': [ctx: RecordEventContext & { columnId: string; recordId: number; linkedIds: number[]; unlink: boolean }];
}

export const bus = new EventEmitter<AppEvents>();
bus.setMaxListeners(50);
