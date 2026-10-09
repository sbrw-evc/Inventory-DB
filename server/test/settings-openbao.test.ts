/** Secrets in OpenBao: the store, integration secrets, the settings page, moving to another OpenBao. */
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../src/db/index.js';
import { encryptSecret } from '../src/integrations/secrets.js';
import { moveLegacySecrets } from '../src/integrations/store.js';
import { getSecret, openBaoClient, secretBackend, setSecret, useLocalSecrets, useOpenBao } from '../src/system/secrets.js';
import { startFakeOpenBao, type FakeOpenBao } from './fake-openbao.js';
import { createTestApp, signUpUser } from './helpers.js';

process.env.CONFIG_DIR = mkdtempSync(join(tmpdir(), 'idb-config-'));

let app: FastifyInstance;
let bao: FakeOpenBao;
let other: FakeOpenBao;
let admin: Record<string, string>;
let viewer: Record<string, string>;

async function api<T = any>(method: string, url: string, payload?: unknown, status = 200, headers = admin): Promise<T> {
  const res = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers, payload: payload as object });
  if (res.statusCode !== status) throw new Error(`${method} ${url} -> ${res.statusCode} (expected ${status}): ${res.body}`);
  return res.json() as T;
}

beforeAll(async () => {
  bao = await startFakeOpenBao();
  other = await startFakeOpenBao({ mounts: ['inventory', 'other'] });
  app = await createTestApp();
  admin = (await signUpUser(app)).headers;
  viewer = (await signUpUser(app)).headers;
  // The first user to open an admin page becomes the DCIM/IPAM (and settings) admin.
  await api('GET', '/settings/openbao');
});

afterAll(async () => {
  useLocalSecrets();
  await bao.close();
  await other.close();
});

describe('secret store', () => {
  it('keeps secrets encrypted in the database while OpenBao is not configured', async () => {
    expect(secretBackend()).toBe('local');
    await setSecret('test/local', { a: '1' });
    const row = getDb().prepare("SELECT data_enc FROM nc_secrets WHERE path = 'test/local'").get() as { data_enc: string };
    expect(row.data_enc).not.toContain('"a"');
    expect(await getSecret('test/local', 'a')).toBe('1');
    const view = await api('GET', '/settings/openbao');
    expect(view).toMatchObject({ configured: false, backend: 'local', local_secrets: 1 });
  });

  it('moves integration secrets of older versions out of the integrations table', async () => {
    const { integration } = await api('POST', '/integrations', { kind: 'umbrella', title: 'Old' }, 201);
    getDb().prepare('UPDATE nc_integrations SET secret_enc = ? WHERE id = ?').run(encryptSecret('whsec_legacy'), integration.id);
    getDb().prepare('DELETE FROM nc_secrets WHERE path = ?').run(`integrations/${integration.id}`);
    expect(await moveLegacySecrets()).toBe(1);
    expect(await getSecret(`integrations/${integration.id}`, 'signing_secret')).toBe('whsec_legacy');
  });

  it('switches to OpenBao, moves the local secrets there and keeps new integration secrets in it', async () => {
    await useOpenBao({ addr: bao.url, mount: 'inventory', auth: 'token', token: bao.token });
    const res = await api('POST', '/settings/openbao/move-local');
    expect(res.moved).toBeGreaterThanOrEqual(2);
    expect(getDb().prepare('SELECT COUNT(*) n FROM nc_secrets').get()).toEqual({ n: 0 });
    expect(bao.store.get('inventory')!.get('test/local')).toEqual({ a: '1' });

    const { integration, secret } = await api('POST', '/integrations', { kind: 'umbrella', title: 'Umbrella' }, 201);
    expect(bao.store.get('inventory')!.get(`integrations/${integration.id}`)).toEqual({ signing_secret: secret });
    const rotated = await api('POST', `/integrations/${integration.id}/rotate-secret`);
    expect(bao.store.get('inventory')!.get(`integrations/${integration.id}`)).toEqual({ signing_secret: rotated.secret });
    await api('DELETE', `/integrations/${integration.id}`);
    expect(bao.store.get('inventory')!.has(`integrations/${integration.id}`)).toBe(false);
  });

  it('shows the connection, status and the secrets by purpose, without values', async () => {
    const view = await api('GET', '/settings/openbao');
    expect(view).toMatchObject({ configured: true, backend: 'openbao', connection: { addr: bao.url, mount: 'inventory', auth: 'token', source: 'environment' } });
    expect(view.status).toMatchObject({ reachable: true, token_ok: true, mount_ok: true, version: '2.7.1' });
    const list = await api<{ path: string; keys: string[]; usage: string; title?: string }[]>('GET', '/settings/openbao/secrets');
    const old = list.find((s) => s.usage === 'integration' && s.title === 'Old');
    expect(old?.keys).toEqual(['signing_secret']);
    expect(JSON.stringify(list)).not.toContain('whsec_');
    const test = await api('POST', '/settings/openbao/test');
    expect(test).toMatchObject({ ok: true, write_ok: true });
    expect([...bao.store.get('inventory')!.keys()].some((k) => k.startsWith('_check/'))).toBe(false);
  });

  it('is only for administrators', async () => {
    await api('GET', '/settings/openbao', undefined, 403, viewer);
    await api('GET', '/settings/openbao/secrets', undefined, 403, viewer);
    await api('GET', '/system/status', undefined, 403, viewer);
  });

  it('checks another OpenBao with AppRole and reports a wrong secret_id', async () => {
    const good = await api('POST', '/settings/openbao/probe', { addr: other.url, mount: 'other', auth: 'approle', role_id: other.roleId, secret_id: other.secretId });
    expect(good).toMatchObject({ ok: true, write_ok: true, secrets: 0 });
    const bad = await api('POST', '/settings/openbao/probe', { addr: other.url, mount: 'other', auth: 'approle', role_id: other.roleId, secret_id: 'nope' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/AppRole/);
    const noMount = await api('POST', '/settings/openbao/probe', { addr: other.url, mount: 'missing', auth: 'token', token: other.token });
    expect(noMount.ok).toBe(false);
  });

  it('moves every secret to another OpenBao and saves the connection', async () => {
    other.store.get('other')!.set('someone/else', { x: 'y' });
    await api('POST', '/settings/openbao/migrate', { target: { addr: other.url, mount: 'other', auth: 'approle', role_id: other.roleId, secret_id: other.secretId } }, 409);
    const done = await api('POST', '/settings/openbao/migrate', {
      target: { addr: other.url, mount: 'other', auth: 'approle', role_id: other.roleId, secret_id: other.secretId },
      overwrite: true,
    });
    expect(done.copied).toBe(bao.store.get('inventory')!.size);
    expect(openBaoClient()!.conn.addr).toBe(other.url);
    expect(other.store.get('other')!.get('test/local')).toEqual({ a: '1' });
    const file = JSON.parse(readFileSync(join(process.env.CONFIG_DIR!, 'inventory.json'), 'utf8'));
    expect(file.openbao).toMatchObject({ addr: other.url, mount: 'other', auth: 'approle', role_id: other.roleId });
    const view = await api('GET', '/settings/openbao');
    expect(view.connection.source).toBe('settings');
    await api('POST', '/settings/openbao/migrate', { target: { addr: other.url, mount: 'other', auth: 'token', token: other.token } }, 409);
  });
});
