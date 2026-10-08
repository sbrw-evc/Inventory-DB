/**
 * Minimal client for NocoDB's v2 REST API (meta + data), used by the NocoDB migration.
 *
 * Authentication uses the `xc-token` header (a NocoDB API token). The token is only ever sent in that header:
 * it never appears in URLs, error messages or logs produced here.
 */

// ---------- NocoDB response shapes (only the parts the migration reads) ----------

export interface NocoBase {
  id: string;
  title: string;
}

export interface NocoTableSummary {
  id: string;
  title: string;
  table_name?: string;
  /** 'table' or 'view' (database views are not migrated) */
  type?: string;
  /** true for the hidden junction tables of many-to-many relations */
  mm?: boolean | number;
  order?: number;
}

export interface NocoSelectOption {
  id?: string;
  title: string;
  color?: string;
  order?: number;
}

export interface NocoColOptions {
  /** SingleSelect / MultiSelect */
  options?: NocoSelectOption[];
  /** Links / LinkToAnotherRecord */
  type?: string;
  fk_related_model_id?: string;
  fk_child_column_id?: string;
  fk_parent_column_id?: string;
  fk_mm_model_id?: string;
  fk_mm_child_column_id?: string;
  fk_mm_parent_column_id?: string;
  /** Lookup / Rollup */
  fk_relation_column_id?: string;
  fk_lookup_column_id?: string;
  fk_rollup_column_id?: string;
  rollup_function?: string;
  /** Formula */
  formula?: string;
  formula_raw?: string;
  [key: string]: unknown;
}

export interface NocoColumn {
  id: string;
  title: string;
  column_name?: string;
  uidt: string;
  pk?: boolean | number;
  pv?: boolean | number;
  system?: boolean | number;
  rqd?: boolean | number;
  ai?: boolean | number;
  cdf?: unknown;
  dtxp?: unknown;
  description?: string | null;
  order?: number;
  meta?: Record<string, unknown> | string | null;
  colOptions?: NocoColOptions | null;
}

export interface NocoTable extends NocoTableSummary {
  columns: NocoColumn[];
}

export interface NocoView {
  id: string;
  title: string;
  /** 1 form, 2 gallery, 3 grid, 4 kanban, 5 map, 6 calendar, 7 list, 8 timeline, 9 gantt */
  type: number | string;
  is_default?: boolean | number;
  order?: number;
  lock_type?: string;
  meta?: Record<string, unknown> | string | null;
  /** Some versions embed the type-specific view settings here. */
  view?: Record<string, unknown> | null;
}

export interface NocoFilter {
  id: string;
  fk_column_id?: string | null;
  fk_parent_id?: string | null;
  comparison_op?: string | null;
  comparison_sub_op?: string | null;
  value?: unknown;
  logical_op?: string | null;
  is_group?: boolean | number | null;
  children?: NocoFilter[];
  order?: number;
}

export interface NocoSort {
  id?: string;
  fk_column_id: string;
  direction?: string;
  order?: number;
}

export interface NocoViewColumn {
  id?: string;
  fk_column_id: string;
  show?: boolean | number;
  order?: number;
  /** Grid: CSS width such as "200px" */
  width?: string | number | null;
  /** Grid group-by */
  group_by?: boolean | number;
  group_by_order?: number;
  group_by_sort?: string;
  /** Form */
  label?: string | null;
  description?: string | null;
  required?: boolean | number;
}

export type NocoRecord = Record<string, unknown>;

export interface NocoPage {
  list: NocoRecord[];
  pageInfo?: { totalRows?: number; page?: number; pageSize?: number; isFirstPage?: boolean; isLastPage?: boolean };
}

// ---------- errors / helpers ----------

export class NocoDBError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'NocoDBError';
  }
}

/**
 * Normalises what a user pastes: adds https:// when missing, drops trailing slashes, hash/query and anything from
 * `/api/` or `/dashboard` on (so a browser URL like https://app.nocodb.com/#/ws/base works). Keeps a sub-path
 * for self-hosted instances served under one.
 */
export function normalizeBaseUrl(input: string): string {
  let raw = input.trim();
  if (!raw) throw new NocoDBError('NocoDB URL is required');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new NocoDBError(`Invalid NocoDB URL: ${input}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NocoDBError(`Invalid NocoDB URL: ${input}`);
  let path = u.pathname;
  const cut = path.search(/\/(api|dashboard)(\/|$)/);
  if (cut >= 0) path = path.slice(0, cut);
  path = path.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tiny promise semaphore. */
class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** Runs `fn` over `items` with at most `concurrency` in flight; results keep input order. */
export async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

const listOf = <T>(body: unknown): T[] => {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object' && Array.isArray((body as { list?: unknown }).list)) return (body as { list: T[] }).list;
  return [];
};

export interface NocoDBClientOptions {
  url: string;
  token: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Max simultaneous requests (NocoDB Cloud rate-limits); default 4. */
  concurrency?: number;
  /** Retries for 429 / 5xx / network errors; default 5. */
  maxRetries?: number;
  /** First backoff delay in ms (doubles each retry); default 500. */
  retryBaseMs?: number;
  /** Per-request timeout in ms; default 60s. */
  timeoutMs?: number;
  /** Page size for records / links; NocoDB's default max is 1000. */
  pageSize?: number;
}

export class NocoDBClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: Limiter;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly timeoutMs: number;
  readonly pageSize: number;
  /** Number of HTTP requests sent (including retries), for diagnostics/tests. */
  requestCount = 0;

  constructor(opts: NocoDBClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.url);
    if (!opts.token?.trim()) throw new NocoDBError('NocoDB API token is required');
    this.token = opts.token.trim();
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.limiter = new Limiter(Math.max(1, opts.concurrency ?? 4));
    this.maxRetries = opts.maxRetries ?? 5;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.pageSize = opts.pageSize ?? 1000;
  }

  /** GET a JSON endpoint under the base URL. */
  async get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    return this.limiter.run(() => this.send<T>(url, path));
  }

  private async send<T>(url: URL, path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      this.requestCount++;
      try {
        res = await this.fetchImpl(url, {
          headers: { 'xc-token': this.token, accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw new NocoDBError(`Could not reach NocoDB at ${this.baseUrl}: ${(err as Error).message}`);
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.maxRetries) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await res.body?.cancel().catch(() => {});
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : this.backoff(attempt));
          continue;
        }
        throw new NocoDBError(
          res.status === 429 ? 'NocoDB rate limit exceeded; try again later' : `NocoDB server error ${res.status} on ${path}`,
          res.status,
        );
      }
      const text = await res.text();
      if (res.status === 401) throw new NocoDBError('Invalid NocoDB API token', 401);
      if (res.status === 403) throw new NocoDBError(`The NocoDB API token has no access to ${path}`, 403);
      if (res.status === 404) throw new NocoDBError(`Not found on NocoDB: ${path}`, 404);
      if (!res.ok) {
        let msg = text.slice(0, 300);
        try {
          const j = JSON.parse(text) as { msg?: string; message?: string; error?: string };
          msg = j.msg ?? j.message ?? j.error ?? msg;
        } catch {
          /* not JSON */
        }
        throw new NocoDBError(`NocoDB request ${path} failed (${res.status}): ${msg}`, res.status);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new NocoDBError(`Unexpected (non-JSON) response from NocoDB for ${path}; is ${this.baseUrl} a NocoDB URL?`, res.status);
      }
    }
  }

  private backoff(attempt: number) {
    return this.retryBaseMs * 2 ** attempt + Math.floor(Math.random() * this.retryBaseMs);
  }

  // ---------- meta ----------

  /**
   * Lists the bases the token can see. NocoDB Cloud groups bases in workspaces
   * (`/meta/workspaces` → `/meta/workspaces/{id}/bases`); self-hosted CE has no workspaces endpoint, so fall back
   * to `/meta/bases`.
   */
  async listBases(): Promise<NocoBase[]> {
    const found = new Map<string, NocoBase>();
    let workspaces: { id: string }[] = [];
    try {
      workspaces = listOf<{ id: string }>(await this.get('/api/v2/meta/workspaces'));
    } catch (err) {
      if (err instanceof NocoDBError && err.status === 401) throw err;
      workspaces = [];
    }
    for (const ws of workspaces) {
      try {
        for (const b of listOf<NocoBase>(await this.get(`/api/v2/meta/workspaces/${encodeURIComponent(ws.id)}/bases`))) {
          found.set(b.id, { id: b.id, title: b.title });
        }
      } catch (err) {
        if (err instanceof NocoDBError && err.status === 401) throw err;
      }
    }
    if (found.size === 0) {
      for (const b of listOf<NocoBase>(await this.get('/api/v2/meta/bases'))) found.set(b.id, { id: b.id, title: b.title });
    }
    return [...found.values()];
  }

  async getBase(baseId: string): Promise<NocoBase> {
    const b = await this.get<NocoBase>(`/api/v2/meta/bases/${encodeURIComponent(baseId)}`);
    return { id: b.id ?? baseId, title: b.title };
  }

  async listTables(baseId: string): Promise<NocoTableSummary[]> {
    return listOf<NocoTableSummary>(await this.get(`/api/v2/meta/bases/${encodeURIComponent(baseId)}/tables`));
  }

  async getTable(tableId: string): Promise<NocoTable> {
    const t = await this.get<NocoTable>(`/api/v2/meta/tables/${encodeURIComponent(tableId)}`);
    return { ...t, columns: Array.isArray(t.columns) ? t.columns : [] };
  }

  async listViews(tableId: string): Promise<NocoView[]> {
    return listOf<NocoView>(await this.get(`/api/v2/meta/tables/${encodeURIComponent(tableId)}/views`));
  }

  /**
   * Returns the view's filters as a tree of root filters, groups carrying `children`. Handles the API returning
   * a flat list (linked by `fk_parent_id`), nested `children`, or groups whose children must be fetched from
   * `/meta/filters/{groupId}/children`.
   */
  async getFilters(viewId: string): Promise<NocoFilter[]> {
    const flat = listOf<NocoFilter>(await this.get(`/api/v2/meta/views/${encodeURIComponent(viewId)}/filters`));
    const ids = new Set(flat.map((f) => f.id));
    const roots = flat.filter((f) => !f.fk_parent_id || !ids.has(f.fk_parent_id));
    const byParent = new Map<string, NocoFilter[]>();
    for (const f of flat) {
      if (f.fk_parent_id && ids.has(f.fk_parent_id)) byParent.set(f.fk_parent_id, [...(byParent.get(f.fk_parent_id) ?? []), f]);
    }
    const fill = async (f: NocoFilter, depth: number): Promise<NocoFilter> => {
      if (!f.is_group) return f;
      let children = f.children ?? byParent.get(f.id);
      if (!children && depth < 10) {
        try {
          children = listOf<NocoFilter>(await this.get(`/api/v2/meta/filters/${encodeURIComponent(f.id)}/children`));
        } catch (err) {
          if (!(err instanceof NocoDBError && err.status === 404)) throw err;
          children = [];
        }
      }
      return { ...f, children: await Promise.all((children ?? []).map((c) => fill(c, depth + 1))) };
    };
    return Promise.all(roots.map((f) => fill(f, 0)));
  }

  async getSorts(viewId: string): Promise<NocoSort[]> {
    return listOf<NocoSort>(await this.get(`/api/v2/meta/views/${encodeURIComponent(viewId)}/sorts`));
  }

  async getViewColumns(viewId: string): Promise<NocoViewColumn[]> {
    return listOf<NocoViewColumn>(await this.get(`/api/v2/meta/views/${encodeURIComponent(viewId)}/columns`));
  }

  /**
   * Type-specific view settings: `kanbans` (fk_grp_col_id, fk_cover_image_col_id, meta), `galleries`
   * (fk_cover_image_col_id), `forms` (heading, subheading, success_msg, redirect_url, columns),
   * `calendars` (calendar_range). Returns null when the endpoint is missing in this NocoDB version.
   */
  async getViewDetails(kind: 'kanbans' | 'galleries' | 'forms' | 'calendars' | 'grids', viewId: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.get<Record<string, unknown>>(`/api/v2/meta/${kind}/${encodeURIComponent(viewId)}`);
    } catch (err) {
      if (err instanceof NocoDBError && err.status && err.status >= 400 && err.status < 500 && err.status !== 401) return null;
      throw err;
    }
  }

  // ---------- data ----------

  async listRecords(tableId: string, offset: number, limit = this.pageSize): Promise<NocoPage> {
    const body = await this.get<NocoPage>(`/api/v2/tables/${encodeURIComponent(tableId)}/records`, { offset, limit });
    return { list: listOf<NocoRecord>(body), pageInfo: (body as NocoPage)?.pageInfo };
  }

  /** Yields every record of a table, page by page. */
  async *iterateRecords(tableId: string): AsyncGenerator<NocoRecord[]> {
    let offset = 0;
    for (let guard = 0; guard < 1_000_000; guard++) {
      const page = await this.listRecords(tableId, offset);
      if (page.list.length) yield page.list;
      if (page.list.length === 0) return;
      if (page.pageInfo?.isLastPage === true) return;
      if (page.pageInfo?.isLastPage === undefined && page.list.length < this.pageSize) return;
      offset += page.list.length;
    }
  }

  /**
   * Linked records of one record through a Links/LinkToAnotherRecord field. Belongs-to links may come back as a
   * single object instead of `{list}`; both are handled.
   */
  async listLinks(tableId: string, linkFieldId: string, recordId: string | number): Promise<NocoRecord[]> {
    const out: NocoRecord[] = [];
    let offset = 0;
    for (let guard = 0; guard < 100_000; guard++) {
      const body = await this.get<unknown>(
        `/api/v2/tables/${encodeURIComponent(tableId)}/links/${encodeURIComponent(linkFieldId)}/records/${encodeURIComponent(String(recordId))}`,
        { offset, limit: this.pageSize },
      );
      if (body == null) return out;
      if (typeof body === 'object' && !Array.isArray(body) && !('list' in body)) {
        if (Object.keys(body).length) out.push(body as NocoRecord);
        return out;
      }
      const list = listOf<NocoRecord>(body);
      out.push(...list);
      const info = (body as NocoPage).pageInfo;
      if (list.length === 0 || info?.isLastPage === true || (info?.isLastPage === undefined && list.length < this.pageSize)) return out;
      offset += list.length;
    }
    return out;
  }
}
