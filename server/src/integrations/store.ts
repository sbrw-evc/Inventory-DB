import type { Integration, IntegrationInput } from '../../../shared/src/index.js';
import { getDb, json, newId, now } from '../db/index.js';
import { notFound } from '../errors.js';
import { decryptSecret, encryptSecret, newSecret } from './secrets.js';

interface IntegrationRow {
  id: string;
  kind: Integration['kind'];
  title: string;
  active: number;
  config: string;
  secret_enc: string;
  created_by: string;
  created_at: string;
}

interface IntegrationConfig {
  umbrellaUrl?: string | null;
  inventoryUrl?: string | null;
}

const toIntegration = (r: IntegrationRow): Integration => {
  const config = json<IntegrationConfig>(r.config, {});
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    active: !!r.active,
    umbrellaUrl: config.umbrellaUrl ?? null,
    inventoryUrl: config.inventoryUrl ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
};

const getRow = (id: string) =>
  getDb().prepare('SELECT * FROM nc_integrations WHERE id = ?').get(id) as IntegrationRow | undefined;

export function listIntegrations(userId: string): Integration[] {
  const rows = getDb().prepare('SELECT * FROM nc_integrations WHERE created_by = ? ORDER BY created_at').all(userId) as IntegrationRow[];
  return rows.map(toIntegration);
}

export function getIntegration(id: string): Integration {
  const row = getRow(id);
  if (!row) throw notFound('Integration');
  return toIntegration(row);
}

/** Integrations are managed by the user who created them; others get 404 so ids don't leak. */
export function getOwnedIntegration(id: string, userId: string): Integration {
  const integration = getIntegration(id);
  if (integration.createdBy !== userId) throw notFound('Integration');
  return integration;
}

/** Returns the integration and its signing secret; the secret is shown to the user only here. */
export function createIntegration(userId: string, input: IntegrationInput): { integration: Integration; secret: string } {
  const secret = newSecret();
  const row: IntegrationRow = {
    id: newId('int'),
    kind: input.kind,
    title: input.title,
    active: input.active === false ? 0 : 1,
    config: JSON.stringify({ umbrellaUrl: input.umbrellaUrl ?? null, inventoryUrl: input.inventoryUrl ?? null }),
    secret_enc: encryptSecret(secret),
    created_by: userId,
    created_at: now(),
  };
  getDb()
    .prepare(
      `INSERT INTO nc_integrations (id, kind, title, active, config, secret_enc, created_by, created_at)
       VALUES (@id, @kind, @title, @active, @config, @secret_enc, @created_by, @created_at)`,
    )
    .run(row);
  return { integration: toIntegration(row), secret };
}

export function updateIntegration(id: string, patch: Partial<Omit<IntegrationInput, 'kind'>>): Integration {
  const row = getRow(id);
  if (!row) throw notFound('Integration');
  const config = { ...json<IntegrationConfig>(row.config, {}) };
  if (patch.umbrellaUrl !== undefined) config.umbrellaUrl = patch.umbrellaUrl;
  if (patch.inventoryUrl !== undefined) config.inventoryUrl = patch.inventoryUrl;
  getDb()
    .prepare('UPDATE nc_integrations SET title = ?, active = ?, config = ? WHERE id = ?')
    .run(patch.title ?? row.title, patch.active === undefined ? row.active : patch.active ? 1 : 0, JSON.stringify(config), id);
  return getIntegration(id);
}

export function deleteIntegration(id: string) {
  getDb().prepare('DELETE FROM nc_integrations WHERE id = ?').run(id);
}

export function rotateSecret(id: string): string {
  const secret = newSecret();
  getDb().prepare('UPDATE nc_integrations SET secret_enc = ? WHERE id = ?').run(encryptSecret(secret), id);
  return secret;
}

export function getSecret(id: string): string {
  const row = getRow(id);
  if (!row) throw notFound('Integration');
  return decryptSecret(row.secret_enc);
}
