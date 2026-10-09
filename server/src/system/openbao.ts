/**
 * Minimal OpenBao (Vault-compatible) client: token or AppRole sign-in, token renewal and the KV v2 secrets engine.
 * Inventory DB keeps every secret it owns under one KV v2 mount (default `inventory`).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { type OpenBaoConnection } from './config.js';
import { logEvent } from './logbuf.js';

export class OpenBaoError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export interface OpenBaoStatus {
  configured: boolean;
  addr?: string;
  mount?: string;
  namespace?: string;
  auth?: string;
  reachable: boolean;
  initialized?: boolean;
  sealed?: boolean;
  version?: string;
  cluster_name?: string;
  token_ok: boolean;
  mount_ok: boolean;
  renewable: boolean;
  token_expires?: string;
  policies?: string[];
  error?: string;
  last_error?: string;
  last_error_at?: string;
  latency_ms: number;
}

export interface OpenBaoReport {
  ok: boolean;
  error?: string;
  write_ok: boolean;
  write_error?: string;
  status: OpenBaoStatus;
}

const TIMEOUT_MS = 10_000;

function fileOr(value: string | undefined, file: string | undefined): string {
  if (value) return value.trim();
  if (file) return readFileSync(file, 'utf8').trim();
  return '';
}

const escapePath = (p: string) =>
  p
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');

export class OpenBaoClient {
  readonly conn: OpenBaoConnection;
  private token = '';
  private expires: number | null = null;
  private renewable = false;
  private policies: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastError: { message: string; at: string } | null = null;
  private loggingIn: Promise<string> | null = null;

  constructor(conn: OpenBaoConnection) {
    this.conn = { ...conn, addr: conn.addr.trim().replace(/\/+$/, ''), mount: (conn.mount || 'inventory').replace(/^\/+|\/+$/g, '') };
  }

  get mount() {
    return this.conn.mount;
  }

  /** Raw HTTP call; returns the status and the parsed JSON body (or null). */
  async raw(method: string, path: string, opts: { body?: unknown; token?: string | null } = {}): Promise<{ status: number; body: any }> {
    const url = new URL(this.conn.addr + path);
    const lib = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = opts.token === undefined ? this.token : opts.token;
    if (token) headers['x-vault-token'] = token;
    if (this.conn.namespace) headers['x-vault-namespace'] = this.conn.namespace;
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (payload !== undefined) headers['content-type'] = 'application/json';
    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method,
          headers,
          timeout: TIMEOUT_MS,
          ...(url.protocol === 'https:' ? { ca: this.conn.ca_cert || undefined, rejectUnauthorized: !this.conn.skip_verify } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown = null;
            try {
              body = text ? JSON.parse(text) : null;
            } catch {
              body = { errors: [text.slice(0, 200)] };
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`OpenBao did not answer within ${TIMEOUT_MS / 1000} s`)));
      req.on('error', (e) => reject(new OpenBaoError(`OpenBao at ${this.conn.addr}: ${e.message}`)));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  private static errorOf(status: number, body: any): string {
    const errs: string[] = Array.isArray(body?.errors) ? body.errors.filter(Boolean) : [];
    if (status === 403) return `permission denied${errs.length ? `: ${errs.join('; ')}` : ''}`;
    if (status === 503) return 'OpenBao is sealed or not initialized';
    return errs.join('; ') || `HTTP ${status}`;
  }

  private fail(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    this.lastError = { message, at: new Date().toISOString() };
    return message;
  }

  /** Signs in (token or AppRole) and starts renewing the token. */
  async login(): Promise<string> {
    if (this.loggingIn) return this.loggingIn;
    this.loggingIn = (async () => {
      try {
        let token: string;
        if (this.conn.auth === 'approle') {
          const roleId = fileOr(this.conn.role_id, this.conn.role_id_file);
          const secretId = fileOr(this.conn.secret_id, this.conn.secret_id_file);
          if (!roleId || !secretId) throw new OpenBaoError('AppRole role_id and secret_id are required');
          const path = (this.conn.approle_path || 'approle').replace(/^\/+|\/+$/g, '');
          const res = await this.raw('POST', `/v1/auth/${escapePath(path)}/login`, { body: { role_id: roleId, secret_id: secretId }, token: null });
          if (res.status !== 200 || !res.body?.auth?.client_token) throw new OpenBaoError(`AppRole sign-in: ${OpenBaoClient.errorOf(res.status, res.body)}`, res.status);
          token = res.body.auth.client_token;
        } else {
          token = fileOr(this.conn.token, this.conn.token_file);
          if (!token) throw new OpenBaoError('OpenBao token is required');
        }
        const info = await this.raw('GET', '/v1/auth/token/lookup-self', { token });
        if (info.status !== 200) throw new OpenBaoError(`Token check: ${OpenBaoClient.errorOf(info.status, info.body)}`, info.status);
        this.token = token;
        this.applyTokenInfo(info.body?.data);
        this.schedule();
        return token;
      } catch (e) {
        this.fail(e);
        throw e;
      } finally {
        this.loggingIn = null;
      }
    })();
    return this.loggingIn;
  }

  private applyTokenInfo(data: any) {
    const ttl = Number(data?.ttl ?? 0);
    this.expires = ttl > 0 ? Date.now() + ttl * 1000 : null;
    this.renewable = !!data?.renewable;
    this.policies = Array.isArray(data?.policies) ? data.policies : [];
  }

  /** Renews the token at two thirds of its lifetime; signs in again with AppRole when renewal fails. */
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.expires) return;
    const delay = Math.max(5_000, Math.min(((this.expires - Date.now()) * 2) / 3, 2 ** 31 - 1));
    this.timer = setTimeout(() => void this.refresh(), delay);
    this.timer.unref();
  }

  private async refresh() {
    try {
      if (this.renewable) {
        const res = await this.raw('POST', '/v1/auth/token/renew-self', { body: {} });
        if (res.status === 200) {
          const auth = res.body?.auth;
          this.expires = auth?.lease_duration ? Date.now() + Number(auth.lease_duration) * 1000 : null;
          this.schedule();
          return;
        }
      }
      if (this.conn.auth !== 'approle') throw new OpenBaoError('the token expires and cannot be renewed');
      await this.login();
    } catch (e) {
      logEvent('error', 'OpenBao token renewal failed', { error: this.fail(e) });
      this.timer = setTimeout(() => void this.refresh(), 30_000);
      this.timer.unref();
    }
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    if (!this.token) await this.login();
    let res = await this.raw(method, path, { body });
    // An expired AppRole token: sign in again once.
    if (res.status === 403 && this.conn.auth === 'approle') {
      await this.login();
      res = await this.raw(method, path, { body });
    }
    return res;
  }

  /** KV v2 read; null when the secret does not exist. */
  async read(path: string): Promise<Record<string, string> | null> {
    try {
      const res = await this.call('GET', `/v1/${escapePath(this.mount)}/data/${escapePath(path)}`);
      if (res.status === 404) return null;
      if (res.status !== 200) throw new OpenBaoError(`read ${path}: ${OpenBaoClient.errorOf(res.status, res.body)}`, res.status);
      return (res.body?.data?.data ?? {}) as Record<string, string>;
    } catch (e) {
      this.fail(e);
      throw e;
    }
  }

  async write(path: string, data: Record<string, string>): Promise<void> {
    try {
      const res = await this.call('POST', `/v1/${escapePath(this.mount)}/data/${escapePath(path)}`, { data });
      if (res.status !== 200 && res.status !== 204) throw new OpenBaoError(`write ${path}: ${OpenBaoClient.errorOf(res.status, res.body)}`, res.status);
    } catch (e) {
      this.fail(e);
      throw e;
    }
  }

  /** Deletes every version and the metadata of a secret. */
  async remove(path: string): Promise<void> {
    const res = await this.call('DELETE', `/v1/${escapePath(this.mount)}/metadata/${escapePath(path)}`);
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw new OpenBaoError(`delete ${path}: ${OpenBaoClient.errorOf(res.status, res.body)}`, res.status);
  }

  /** All secret paths of the mount (recursively). */
  async list(prefix = ''): Promise<string[]> {
    const res = await this.call('GET', `/v1/${escapePath(this.mount)}/metadata/${escapePath(prefix)}${prefix ? '/' : ''}?list=true`);
    if (res.status === 404) return [];
    if (res.status !== 200) throw new OpenBaoError(`list: ${OpenBaoClient.errorOf(res.status, res.body)}`, res.status);
    const keys: string[] = res.body?.data?.keys ?? [];
    const out: string[] = [];
    for (const k of keys) {
      const full = prefix ? `${prefix}/${k}` : k;
      if (k.endsWith('/')) out.push(...(await this.list(full.replace(/\/+$/, ''))));
      else out.push(full);
    }
    return out.sort();
  }

  /** Health, sign-in and mount access, for the settings and status pages. Never throws. */
  async status(): Promise<OpenBaoStatus> {
    const started = Date.now();
    const s: OpenBaoStatus = {
      configured: true,
      addr: this.conn.addr,
      mount: this.mount,
      namespace: this.conn.namespace,
      auth: this.conn.auth,
      reachable: false,
      token_ok: false,
      mount_ok: false,
      renewable: false,
      latency_ms: 0,
    };
    try {
      const health = await this.raw('GET', '/v1/sys/health?standbyok=true&sealedcode=200&uninitcode=200&perfstandbyok=true', { token: null });
      s.reachable = true;
      s.initialized = health.body?.initialized;
      s.sealed = health.body?.sealed;
      s.version = health.body?.version;
      s.cluster_name = health.body?.cluster_name;
      if (s.sealed) throw new OpenBaoError('OpenBao is sealed');
      if (s.initialized === false) throw new OpenBaoError('OpenBao is not initialized');
      if (!this.token) await this.login();
      const info = await this.raw('GET', '/v1/auth/token/lookup-self');
      if (info.status !== 200) {
        if (this.conn.auth !== 'approle') throw new OpenBaoError(`Token check: ${OpenBaoClient.errorOf(info.status, info.body)}`);
        await this.login();
      } else this.applyTokenInfo(info.body?.data);
      s.token_ok = true;
      s.renewable = this.renewable;
      s.token_expires = this.expires ? new Date(this.expires).toISOString() : undefined;
      s.policies = this.policies;
      const list = await this.raw('GET', `/v1/${escapePath(this.mount)}/metadata/?list=true`);
      const errs: string[] = Array.isArray(list.body?.errors) ? list.body.errors : [];
      if (list.status === 200 || (list.status === 404 && errs.length === 0)) s.mount_ok = true;
      else throw new OpenBaoError(`KV v2 mount ${this.mount}/: ${OpenBaoClient.errorOf(list.status, list.body)}`);
    } catch (e) {
      s.error = e instanceof Error ? e.message : String(e);
    }
    s.latency_ms = Date.now() - started;
    if (this.lastError) {
      s.last_error = this.lastError.message;
      s.last_error_at = this.lastError.at;
    }
    return s;
  }

  /** Status plus a write, read and delete of a throw-away secret. */
  async verify(): Promise<OpenBaoReport> {
    const status = await this.status();
    const report: OpenBaoReport = { ok: !status.error, error: status.error, write_ok: false, status };
    if (status.error) return report;
    const path = `_check/${randomBytes(6).toString('hex')}`;
    try {
      await this.write(path, { value: 'ok' });
      const back = await this.read(path);
      if (back?.value !== 'ok') throw new OpenBaoError('the secret written could not be read back');
      await this.remove(path);
      report.write_ok = true;
    } catch (e) {
      report.ok = false;
      report.write_error = e instanceof Error ? e.message : String(e);
      report.error = report.write_error;
    }
    return report;
  }
}
