/** OpenBao settings page: the current connection, the secrets it holds, a check of another OpenBao and moving there. */
import { getDb } from '../db/index.js';
import { HttpError } from '../errors.js';
import { integrationTitles } from '../integrations/store.js';
import { type OpenBaoConnection, readConfig, writeConfig } from './config.js';
import { logEvent } from './logbuf.js';
import { OpenBaoClient } from './openbao.js';
import { copySecretsTo, listSecrets, localSecretCount, openBaoClient, secretBackend, setSecret, useOpenBao } from './secrets.js';

export type SecretUsage = 'integration' | 'ldap' | 'entra' | 'postgres' | 'jwt' | 'other';

/** What a secret path is used for (the page lists secrets by purpose, never their values). */
export function secretUsage(path: string, titles: Record<string, string> = {}): { usage: SecretUsage; title?: string } {
  const m = /^integrations\/(.+)$/.exec(path);
  if (m) return { usage: 'integration', title: titles[m[1]] };
  if (path === 'directory/ldap') return { usage: 'ldap' };
  if (path === 'directory/entra') return { usage: 'entra' };
  if (path === 'system/postgres') return { usage: 'postgres' };
  if (path === 'system/jwt') return { usage: 'jwt' };
  return { usage: 'other' };
}

function publicConnection(c: OpenBaoConnection) {
  return {
    addr: c.addr,
    mount: c.mount,
    namespace: c.namespace || undefined,
    auth: c.auth,
    approle_path: c.auth === 'approle' ? c.approle_path || 'approle' : undefined,
    custom_ca: !!c.ca_cert,
    skip_verify: !!c.skip_verify,
    source: readConfig().openbao ? 'settings' : 'environment',
  };
}

export async function openBaoOverview() {
  const client = openBaoClient();
  const local = localSecretCount();
  if (!client) return { configured: false, backend: secretBackend(), local_secrets: local, secrets: local };
  const status = await client.status();
  let secrets = 0;
  let listError: string | undefined;
  try {
    secrets = (await listSecrets()).length;
  } catch (e) {
    listError = (e as Error).message;
  }
  return { configured: true, backend: secretBackend(), connection: publicConnection(client.conn), status, secrets, local_secrets: local, list_error: listError };
}

/** Paths, key names and purpose of every stored secret. */
export async function secretList() {
  const titles = integrationTitles();
  return (await listSecrets()).map((s) => ({ ...s, ...secretUsage(s.path, titles) }));
}

export async function testOpenBao() {
  const client = openBaoClient();
  if (!client) throw new HttpError(409, 'OPENBAO_NOT_CONFIGURED', 'OpenBao is not configured');
  return client.verify();
}

export async function probeOpenBao(target: OpenBaoConnection) {
  const client = new OpenBaoClient(target);
  try {
    const report = await client.verify();
    let secrets = 0;
    if (report.ok) secrets = (await client.list()).filter((p) => !p.startsWith('_check/')).length;
    return { ...report, secrets };
  } catch (e) {
    return { ok: false, error: (e as Error).message, write_ok: false, status: await client.status(), secrets: 0 };
  } finally {
    client.close();
  }
}

const sameBao = (a: OpenBaoConnection, b: OpenBaoConnection) =>
  a.addr.replace(/\/+$/, '').toLowerCase() === b.addr.replace(/\/+$/, '').toLowerCase() && a.mount === b.mount && (a.namespace ?? '') === (b.namespace ?? '');

/** Copies every secret into `target`, saves the connection and makes it the secret store. */
export async function migrateOpenBao(target: OpenBaoConnection, overwrite: boolean, userEmail?: string) {
  const current = openBaoClient();
  if (current && sameBao(current.conn, target)) throw new HttpError(409, 'OPENBAO_SAME', 'This is the OpenBao Inventory DB already uses');
  const probe = await probeOpenBao(target);
  if (!probe.ok) throw new HttpError(400, 'OPENBAO_UNREACHABLE', probe.error ?? 'OpenBao does not answer');
  if (probe.secrets > 0 && !overwrite) throw new HttpError(409, 'OPENBAO_NOT_EMPTY', 'The target mount already holds secrets');
  const fromLocal = secretBackend() === 'local';
  const client = new OpenBaoClient(target);
  let copied: string[];
  try {
    copied = await copySecretsTo(client);
  } catch (e) {
    throw new HttpError(500, 'OPENBAO_MIGRATION_FAILED', `The secrets were not moved: ${(e as Error).message}`);
  } finally {
    client.close();
  }
  writeConfig({ openbao: target });
  // With the database password in a settings file and no OpenBao before, it can now move to OpenBao too.
  const pgFile = readConfig().postgres;
  await useOpenBao(target);
  if (fromLocal) for (const path of copied) getDb().prepare('DELETE FROM nc_secrets WHERE path = ?').run(path);
  if (pgFile?.password_in === 'file' && pgFile.password) {
    await setSecret('system/postgres', { password: pgFile.password });
    const { password: _password, ...rest } = pgFile;
    writeConfig({ postgres: { ...rest, password_in: 'openbao' } });
  }
  logEvent('warn', 'Secrets moved to another OpenBao', { to: `${target.addr} (${target.mount})`, by: userEmail, count: copied.length });
  return { addr: target.addr, mount: target.mount, copied: copied.length };
}
