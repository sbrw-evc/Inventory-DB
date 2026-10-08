/**
 * Tiny REST client for the DCIM/IPAM API. Uses the JWT the main app stores in localStorage under `token`.
 * (Kept separate from the main app's client while both are built in parallel; safe to unify later.)
 */
export const TOKEN_KEY = 'token';
export const API_BASE = '/api/v1';

export interface Ref {
  id: number;
  url: string;
  display: string;
  [key: string]: unknown;
}

export interface Choice {
  value: string;
  label: string;
}

export type NbObject = Ref & {
  display_url?: string;
  tags?: Ref[];
  custom_fields?: Record<string, unknown>;
  created?: string;
  last_updated?: string;
};

export interface Page<T = NbObject> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface FieldSchema {
  name: string;
  kind: 'string' | 'text' | 'slug' | 'int' | 'float' | 'bool' | 'choice' | 'fk' | 'm2m' | 'color' | 'date' | 'json' | 'mac' | 'cidr' | 'ipaddr';
  required: boolean;
  read_only: boolean;
  default: unknown;
  ref: string | null;
  choices: { value: string | number; label: string }[] | null;
  max_length: number | null;
  min: number | null;
  max: number | null;
}

export interface ModelSchema {
  object_type: string;
  app: string;
  path: string;
  url: string;
  verbose_name: string;
  verbose_name_plural: string;
  read_only: boolean;
  taggable: boolean;
  custom_fields: boolean;
  filters: string[];
  write_extras: string[];
  fields: FieldSchema[];
}

export interface Me {
  user: { id: string; email: string; name: string };
  role: 'admin' | 'editor' | 'viewer';
  can_write: boolean;
  is_admin: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  /** Field → messages, when the server returned NetBox-style validation errors. */
  get fieldErrors(): Record<string, string[]> {
    const d = this.details;
    return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, string[]>) : {};
  }
}

const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

export type QueryInit = Record<string, string | number | boolean | undefined | null | (string | number)[]>;

export function toQuery(params: QueryInit = {}): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export async function request<T = unknown>(method: string, path: string, body?: unknown, init: { contentType?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (typeof body === 'string' && init.contentType) {
      headers['Content-Type'] = init.contentType;
      payload = body;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const url = path.startsWith('/api/') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, { method, headers, body: payload });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = (data ?? {}) as { message?: string; details?: unknown };
    throw new ApiError(res.status, err.message ?? `HTTP ${res.status}`, err.details);
  }
  return data as T;
}

/** API path for a model, e.g. `/dcim/devices`. */
export const modelPath = (m: Pick<ModelSchema, 'app' | 'path'>) => `/${m.app}/${m.path}`;

export const nb = {
  list: <T = NbObject>(m: Pick<ModelSchema, 'app' | 'path'>, params?: QueryInit) => request<Page<T>>('GET', `${modelPath(m)}${toQuery(params)}`),
  get: <T = NbObject>(m: Pick<ModelSchema, 'app' | 'path'>, id: number | string) => request<T>('GET', `${modelPath(m)}/${id}`),
  create: (m: Pick<ModelSchema, 'app' | 'path'>, body: unknown) => request<NbObject>('POST', modelPath(m), body),
  update: (m: Pick<ModelSchema, 'app' | 'path'>, id: number, body: unknown) => request<NbObject>('PATCH', `${modelPath(m)}/${id}`, body),
  remove: (m: Pick<ModelSchema, 'app' | 'path'>, id: number) => request<void>('DELETE', `${modelPath(m)}/${id}`),
  bulkRemove: (m: Pick<ModelSchema, 'app' | 'path'>, ids: number[]) => request<void>('DELETE', modelPath(m), ids.map((id) => ({ id }))),
  importCsv: (objectType: string, csv: string) => request<{ created: number; results: NbObject[] }>('POST', `/netbox/import/${objectType}`, csv, { contentType: 'text/csv' }),
  schema: () => request<{ results: ModelSchema[] }>('GET', '/netbox/schema'),
  me: () => request<Me>('GET', '/netbox/me'),
  search: (q: string) => request<{ count: number; results: (Ref & { object_type: string; object_type_label: string; display_url: string })[] }>('GET', `/netbox/search${toQuery({ q })}`),
  raw: request,
};
