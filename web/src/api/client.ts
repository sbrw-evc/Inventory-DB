export const API_BASE = '/api/v1';
// Shared with the NetBox pages (web/src/netbox/api.ts reads the same key).
const TOKEN_KEY = 'token';

export class ApiRequestError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent('inventorydb:auth', { detail: { token } }));
}

export interface RequestOptions {
  body?: unknown;
  /** Multipart body; sent as-is without a JSON content type. */
  form?: FormData;
  headers?: Record<string, string>;
  /** Return the raw Response (for downloads). */
  raw?: boolean;
  /** Don't attach the JWT (public endpoints). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

async function parseError(res: Response): Promise<ApiRequestError> {
  let code = 'HTTP_' + res.status;
  let message = res.statusText || `Request failed (${res.status})`;
  let details: unknown;
  try {
    const data = await res.json();
    if (data && typeof data === 'object') {
      code = data.error ?? code;
      message = data.message ?? message;
      details = data.details;
    }
  } catch {
    /* not JSON */
  }
  return new ApiRequestError(res.status, code, message, details);
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const token = opts.anonymous ? null : getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(API_BASE + path, { method, headers, body, signal: opts.signal });
  if (!res.ok) {
    const err = await parseError(res);
    // An expired/invalid session: drop the token so the app returns to sign-in.
    if (res.status === 401 && token && !path.startsWith('/public/') && !path.startsWith('/auth/sign')) setToken(null);
    throw err;
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const http = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, { ...opts, body }),
  del: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('DELETE', path, { ...opts, body }),
};

/** Saves a Response body as a file using the server-provided filename when present. */
export async function saveResponseAsFile(res: Response, fallbackName: string) {
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = match ? decodeURIComponent(match[1]) : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
