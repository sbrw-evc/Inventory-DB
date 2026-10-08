import type {
  ApiToken,
  Attachment,
  AuditEntry,
  Base,
  BaseMember,
  Column,
  ColumnOptions,
  Comment,
  FieldType,
  FilterGroup,
  GroupResult,
  Job,
  ListQuery,
  ListResult,
  RecordData,
  Role,
  Sort,
  Table,
  User,
  View,
  ViewColumn,
  ViewMeta,
  ViewType,
  Webhook,
  WebhookLog,
} from '@shared';
import { http, request, saveResponseAsFile } from './client';
import { buildQuery, listQueryString } from './query';

export type BaseWithTables = Base & { tables: Table[] };

export interface ColumnInput {
  title: string;
  type: FieldType;
  options?: ColumnOptions;
  required?: boolean;
  defaultValue?: unknown;
  description?: string | null;
  primary?: boolean;
}

export interface ViewPatch {
  title?: string;
  order?: number;
  locked?: boolean;
  filter?: FilterGroup | null;
  sorts?: Sort[];
  columns?: ViewColumn[];
  meta?: ViewMeta;
}

export interface ImportSheetPreview {
  name: string;
  headers: string[];
  sampleRows: unknown[][];
  inferredTypes: FieldType[];
}

export interface ImportOptions {
  tableTitle?: string;
  tableId?: string;
  /** header → column id (existing table) */
  columnMap?: Record<string, string | null>;
  sheet?: string;
}

export interface PublicViewData {
  view: View;
  table: Table;
}

export type WebhookInput = Omit<Webhook, 'id' | 'tableId'>;

export interface MigrationResult {
  baseId?: string;
  skipped?: unknown[];
}

const enc = encodeURIComponent;

export const authApi = {
  signUp: (body: { email: string; password: string; name?: string }) =>
    http.post<{ user: User; token: string }>('/auth/signup', body, { anonymous: true }),
  signIn: (body: { email: string; password: string }) =>
    http.post<{ user: User; token: string }>('/auth/signin', body, { anonymous: true }),
  me: () => http.get<{ user: User }>('/auth/me'),
};

export const metaApi = {
  listBases: () => http.get<Base[]>('/bases'),
  createBase: (body: { title: string; description?: string; color?: string }) => http.post<Base>('/bases', body),
  getBase: (baseId: string) => http.get<BaseWithTables>(`/bases/${enc(baseId)}`),
  updateBase: (baseId: string, body: Partial<Pick<Base, 'title' | 'description' | 'color' | 'order'>>) =>
    http.patch<Base>(`/bases/${enc(baseId)}`, body),
  deleteBase: (baseId: string) => http.del<{ ok: true }>(`/bases/${enc(baseId)}`),
  createInventoryTemplate: () => http.post<Base>('/bases/templates/inventory', {}),

  createTable: (baseId: string, body: { title: string; columns?: ColumnInput[] }) =>
    http.post<Table>(`/bases/${enc(baseId)}/tables`, body),
  getTable: (tableId: string) => http.get<Table>(`/tables/${enc(tableId)}`),
  updateTable: (tableId: string, body: { title?: string; description?: string; order?: number }) =>
    http.patch<Table>(`/tables/${enc(tableId)}`, body),
  deleteTable: (tableId: string) => http.del<{ ok: true }>(`/tables/${enc(tableId)}`),

  createColumn: (tableId: string, body: ColumnInput) => http.post<Column>(`/tables/${enc(tableId)}/columns`, body),
  updateColumn: (columnId: string, body: Partial<ColumnInput>) => http.patch<Column>(`/columns/${enc(columnId)}`, body),
  deleteColumn: (columnId: string) => http.del<{ ok: true }>(`/columns/${enc(columnId)}`),

  createView: (tableId: string, body: { title: string; type: ViewType; copyFromViewId?: string }) =>
    http.post<View>(`/tables/${enc(tableId)}/views`, body),
  updateView: (viewId: string, body: ViewPatch) => http.patch<View>(`/views/${enc(viewId)}`, body),
  deleteView: (viewId: string) => http.del<{ ok: true }>(`/views/${enc(viewId)}`),
};

export const dataApi = {
  list: (tableId: string, q: ListQuery, signal?: AbortSignal) =>
    http.get<ListResult>(`/tables/${enc(tableId)}/records${listQueryString(q)}`, { signal }),
  get: (tableId: string, id: number) => http.get<RecordData>(`/tables/${enc(tableId)}/records/${id}`),
  create: (tableId: string, data: Record<string, unknown>) =>
    http.post<RecordData>(`/tables/${enc(tableId)}/records`, data),
  createMany: (tableId: string, data: Record<string, unknown>[]) =>
    http.post<RecordData[]>(`/tables/${enc(tableId)}/records`, data),
  update: (tableId: string, id: number, data: Record<string, unknown>) =>
    http.patch<RecordData>(`/tables/${enc(tableId)}/records/${id}`, data),
  updateMany: (tableId: string, rows: Array<{ id: number } & Record<string, unknown>>) =>
    http.patch<RecordData[]>(`/tables/${enc(tableId)}/records`, rows),
  remove: (tableId: string, id: number) => http.del<{ deleted: number }>(`/tables/${enc(tableId)}/records/${id}`),
  removeMany: (tableId: string, ids: number[]) =>
    http.del<{ deleted: number }>(`/tables/${enc(tableId)}/records`, { ids }),
  groups: (
    tableId: string,
    q: { viewId?: string; columnId: string; filter?: FilterGroup; search?: string },
    signal?: AbortSignal,
  ) =>
    http.get<GroupResult[]>(
      `/tables/${enc(tableId)}/groups${buildQuery({
        viewId: q.viewId,
        columnId: q.columnId,
        filter: q.filter && q.filter.children.length ? q.filter : undefined,
        search: q.search?.trim() || undefined,
      })}`,
      { signal },
    ),
  listLinks: (tableId: string, id: number, columnId: string, q: { offset?: number; limit?: number; search?: string }) =>
    http.get<ListResult>(
      `/tables/${enc(tableId)}/records/${id}/links/${enc(columnId)}${buildQuery({ ...q, search: q.search || undefined })}`,
    ),
  link: (tableId: string, id: number, columnId: string, ids: number[]) =>
    http.post<{ ok: true }>(`/tables/${enc(tableId)}/records/${id}/links/${enc(columnId)}`, { ids }),
  unlink: (tableId: string, id: number, columnId: string, ids: number[]) =>
    http.del<{ ok: true }>(`/tables/${enc(tableId)}/records/${id}/links/${enc(columnId)}`, { ids }),
};

export const platformApi = {
  listMembers: (baseId: string) => http.get<BaseMember[]>(`/bases/${enc(baseId)}/members`),
  inviteMember: (baseId: string, body: { email: string; role: Role }) =>
    http.post<BaseMember>(`/bases/${enc(baseId)}/members`, body),
  updateMember: (baseId: string, userId: string, role: Role) =>
    http.patch<BaseMember>(`/bases/${enc(baseId)}/members/${enc(userId)}`, { role }),
  removeMember: (baseId: string, userId: string) =>
    http.del<{ ok: true }>(`/bases/${enc(baseId)}/members/${enc(userId)}`),

  listTokens: () => http.get<ApiToken[]>('/tokens'),
  createToken: (description: string) => http.post<ApiToken>('/tokens', { description }),
  deleteToken: (tokenId: string) => http.del<{ ok: true }>(`/tokens/${enc(tokenId)}`),

  shareView: (viewId: string, password?: string | null) =>
    http.post<{ shareUuid: string }>(`/views/${enc(viewId)}/share`, { password: password ?? null }),
  unshareView: (viewId: string) => http.del<{ ok: true }>(`/views/${enc(viewId)}/share`),

  listHooks: (tableId: string) => http.get<Webhook[]>(`/tables/${enc(tableId)}/hooks`),
  createHook: (tableId: string, body: WebhookInput) => http.post<Webhook>(`/tables/${enc(tableId)}/hooks`, body),
  updateHook: (hookId: string, body: Partial<WebhookInput>) => http.patch<Webhook>(`/hooks/${enc(hookId)}`, body),
  deleteHook: (hookId: string) => http.del<{ ok: true }>(`/hooks/${enc(hookId)}`),
  testHook: (hookId: string) => http.post<unknown>(`/hooks/${enc(hookId)}/test`, {}),
  hookLogs: (hookId: string) => http.get<WebhookLog[]>(`/hooks/${enc(hookId)}/logs`),

  listComments: (tableId: string, id: number) => http.get<Comment[]>(`/tables/${enc(tableId)}/records/${id}/comments`),
  addComment: (tableId: string, id: number, body: string) =>
    http.post<Comment>(`/tables/${enc(tableId)}/records/${id}/comments`, { body }),
  deleteComment: (commentId: string) => http.del<{ ok: true }>(`/comments/${enc(commentId)}`),
  recordAudit: (tableId: string, id: number) => http.get<AuditEntry[]>(`/tables/${enc(tableId)}/records/${id}/audit`),
  baseAudit: (baseId: string, q: { offset?: number; limit?: number }) =>
    http.get<AuditEntry[]>(`/bases/${enc(baseId)}/audit${buildQuery(q)}`),

  importPreview: (baseId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ sheets: ImportSheetPreview[] }>('POST', `/bases/${enc(baseId)}/import/preview`, { form });
  },
  importFile: (baseId: string, file: File, opts: ImportOptions) => {
    const form = new FormData();
    // Fields first so streaming multipart parsers see them before the file.
    if (opts.tableTitle) form.append('tableTitle', opts.tableTitle);
    if (opts.tableId) form.append('tableId', opts.tableId);
    if (opts.columnMap) form.append('columnMap', JSON.stringify(opts.columnMap));
    if (opts.sheet) form.append('sheet', opts.sheet);
    form.append('file', file);
    return request<{ table: Table; inserted: number }>('POST', `/bases/${enc(baseId)}/import`, { form });
  },
  exportView: async (viewId: string, format: 'csv' | 'xlsx', fallbackName: string) => {
    const res = await request<Response>('GET', `/views/${enc(viewId)}/export${buildQuery({ format })}`, { raw: true });
    await saveResponseAsFile(res, `${fallbackName}.${format}`);
  },
  uploadFile: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<Attachment>('POST', '/files', { form });
  },
};

const pwHeaders = (password?: string | null): Record<string, string> =>
  password ? { 'xc-password': password } : {};

export const publicApi = {
  getView: (shareUuid: string, password?: string | null) =>
    http.get<PublicViewData>(`/public/views/${enc(shareUuid)}`, { anonymous: true, headers: pwHeaders(password) }),
  listRecords: (shareUuid: string, q: ListQuery, password?: string | null, signal?: AbortSignal) =>
    http.get<ListResult>(`/public/views/${enc(shareUuid)}/records${listQueryString({ ...q, viewId: undefined })}`, {
      anonymous: true,
      headers: pwHeaders(password),
      signal,
    }),
  submitForm: (shareUuid: string, data: Record<string, unknown>, password?: string | null) =>
    http.post<RecordData>(`/public/views/${enc(shareUuid)}/submit`, data, {
      anonymous: true,
      headers: pwHeaders(password),
    }),
};

export const migrateApi = {
  listNocoBases: (body: { url: string; token: string }) =>
    http.post<Array<{ id: string; title: string }>>('/migrate/nocodb/bases', body),
  start: (body: { url: string; token: string; nocoBaseId: string; targetTitle?: string }) =>
    http.post<Job>('/migrate/nocodb', body),
  job: (jobId: string) => http.get<Job>(`/jobs/${enc(jobId)}`),
};
