import type { ColumnOptions, FieldPermissions, Role } from './types.js';
import type { FieldType } from './fieldTypes.js';
import { isReadOnlyType } from './fieldTypes.js';

/** Roles a field permission can restrict (owners always have full access). */
export const RESTRICTABLE_ROLES: readonly Role[] = ['editor', 'commenter', 'viewer'];

type Col = { type: FieldType; options?: ColumnOptions | null };

const perms = (c: Col): FieldPermissions => c.options?.permissions ?? {};

/**
 * Whether `role` can't see the field. `role` undefined means an anonymous (shared view) visitor, who can't see
 * a field hidden for any role.
 */
export function isFieldHidden(c: Col, role: Role | undefined): boolean {
  const hidden = perms(c).hiddenFor ?? [];
  if (role === 'owner') return false;
  if (role === undefined) return hidden.length > 0;
  return hidden.includes(role);
}

/** Whether `role` can't write the field (hidden fields are not writable either). Ignores the field type. */
export function isFieldReadOnlyFor(c: Col, role: Role | undefined): boolean {
  if (role === 'owner') return false;
  if (isFieldHidden(c, role)) return true;
  const ro = perms(c).readOnlyFor ?? [];
  if (role === undefined) return ro.length > 0;
  return ro.includes(role);
}

/** The field can't be edited by `role`: computed/system type, or read-only by permission. */
export function isFieldLocked(c: Col, role: Role | undefined): boolean {
  return isReadOnlyType(c.type) || isFieldReadOnlyFor(c, role);
}

// ---------------------------------------------------------------------------------------------------------------
// GeoData: stored as "lat;lng" like NocoDB

export interface LatLng {
  lat: number;
  lng: number;
}

/** Parses "lat;lng" (also "lat,lng", [lat, lng] or {lat, lng}); null when empty or invalid. */
export function parseGeo(v: unknown): LatLng | null {
  if (v == null || v === '') return null;
  let lat: unknown;
  let lng: unknown;
  if (Array.isArray(v)) [lat, lng] = v;
  else if (typeof v === 'object') ({ lat, lng } = v as { lat?: unknown; lng?: unknown });
  else if (typeof v === 'string') {
    const parts = v.trim().split(/\s*[;,]\s*|\s+/);
    if (parts.length !== 2) return null;
    [lat, lng] = parts;
  } else return null;
  const toNum = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);
  const a = toNum(lat);
  const b = toNum(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < -90 || a > 90 || b < -180 || b > 180) return null;
  return { lat: a, lng: b };
}

export const formatGeo = (p: LatLng): string => `${p.lat};${p.lng}`;
