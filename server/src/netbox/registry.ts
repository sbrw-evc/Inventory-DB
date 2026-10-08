import { dcimModels } from './models/dcim.js';
import { extrasModels } from './models/extras.js';
import { ipamModels } from './models/ipam.js';
import { tenancyModels } from './models/tenancy.js';
import type { FieldDef, ModelDef } from './types.js';

export const models: ModelDef[] = [...dcimModels, ...ipamModels, ...tenancyModels, ...extrasModels];

const byType = new Map(models.map((m) => [m.type, m]));
const byPath = new Map(models.map((m) => [`${m.app}/${m.path}`, m]));
const fieldMaps = new Map(models.map((m) => [m.type, new Map(m.fields.map((f) => [f.name, f]))]));

export const modelByType = (type: string) => byType.get(type);
export const modelByPath = (app: string, path: string) => byPath.get(`${app}/${path}`);
export const fieldOf = (m: ModelDef, name: string): FieldDef | undefined => fieldMaps.get(m.type)!.get(name);

/** Accepts `dcim.device`, `devices` or `dcim/devices`. */
export function resolveModel(key: string): ModelDef | undefined {
  if (byType.has(key)) return byType.get(key);
  if (key.includes('/')) return byPath.get(key);
  return models.find((m) => m.path === key);
}

/** Fields of other models that reference `type` (fk or m2m). */
export function referencesTo(type: string): { model: ModelDef; field: FieldDef }[] {
  const out: { model: ModelDef; field: FieldDef }[] = [];
  for (const m of models) for (const f of m.fields) if ((f.kind === 'fk' || f.kind === 'm2m') && f.ref === type) out.push({ model: m, field: f });
  return out;
}

export const isTaggable = (m: ModelDef) => m.taggable !== false && !m.readOnlyModel;
export const hasCustomFields = (m: ModelDef) => m.customFields !== false && !m.readOnlyModel;
export const apiUrl = (m: ModelDef, id: number) => `/api/v1/${m.app}/${m.path}/${id}/`;
export const uiUrl = (m: ModelDef, id: number) => `/${m.app}/${m.path}/${id}`;
