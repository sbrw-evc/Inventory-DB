import type { FlowDelivery, Integration, IntegrationInput } from '../../../shared/src/index.js';
import { getDb, json, newId, now } from '../db/index.js';
import { notFound } from '../errors.js';
import { deleteSecret, getSecret as readSecret, setSecret } from '../system/secrets.js';
import { decryptSecret, newSecret } from './secrets.js';

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

interface IntegrationConfig extends IntegrationActivity {
  umbrellaUrl?: string | null;
  inventoryUrl?: string | null;
  flowUrl?: string | null;
  flowTokenSet?: boolean;
  /** Kind `flow`: after a rotation, hooks are signed with the previous secret too until then. */
  previousSecretUntil?: string | null;
}

interface IntegrationActivity {
  lastFeedAt?: string | null;
  lastFeedCount?: number | null;
  lastAlertAt?: string | null;
  lastDelivery?: FlowDelivery | null;
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
    lastFeedAt: config.lastFeedAt ?? null,
    lastFeedCount: config.lastFeedCount ?? null,
    lastAlertAt: config.lastAlertAt ?? null,
    ...(r.kind === 'flow'
      ? { flowUrl: config.flowUrl ?? null, flowTokenSet: !!config.flowTokenSet, lastDelivery: config.lastDelivery ?? null }
      : {}),
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

/** Where an integration's signing secret is kept in the secret store (OpenBao). */
export const secretPath = (id: string) => `integrations/${id}`;
const SECRET_KEY = 'signing_secret';
/** Kind `flow`: the API token Inventory DB calls Flow with, next to the signing secret. */
const FLOW_TOKEN_KEY = 'flow_token';
/** Kind `flow`: the signing secret before the last rotation, still used for a grace period. */
const PREVIOUS_SECRET_KEY = 'previous_signing_secret';
/** How long Flow hooks keep carrying the old signature after a rotation (contract: two signatures during rotation). */
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

/** Active `flow` integrations, oldest first (the first one answers the traffic proxy endpoints). */
export function activeFlowIntegrations(): Integration[] {
  const rows = getDb().prepare("SELECT * FROM nc_integrations WHERE kind = 'flow' AND active = 1 ORDER BY created_at, id").all() as IntegrationRow[];
  return rows.map(toIntegration).filter((i) => !!i.flowUrl);
}

/** Returns the integration and its signing secret; the secret is shown to the user only here. */
export async function createIntegration(userId: string, input: IntegrationInput): Promise<{ integration: Integration; secret: string }> {
  const secret = newSecret();
  const row: IntegrationRow = {
    id: newId('int'),
    kind: input.kind,
    title: input.title,
    active: input.active === false ? 0 : 1,
    config: JSON.stringify(
      input.kind === 'flow'
        ? { flowUrl: stripSlash(input.flowUrl), flowTokenSet: !!input.flowToken }
        : { umbrellaUrl: input.umbrellaUrl ?? null, inventoryUrl: input.inventoryUrl ?? null },
    ),
    // Kept in the secret store; the column only holds secrets of older versions until they are moved.
    secret_enc: '',
    created_by: userId,
    created_at: now(),
  };
  await setSecret(secretPath(row.id), { [SECRET_KEY]: secret, ...(input.kind === 'flow' ? { [FLOW_TOKEN_KEY]: input.flowToken } : {}) });
  getDb()
    .prepare(
      `INSERT INTO nc_integrations (id, kind, title, active, config, secret_enc, created_by, created_at)
       VALUES (@id, @kind, @title, @active, @config, @secret_enc, @created_by, @created_at)`,
    )
    .run(row);
  return { integration: toIntegration(row), secret };
}

/** Remembers when Umbrella last pulled the full CMDB feed / last delivered alerts (shown on the admin page). */
export function recordActivity(id: string, patch: IntegrationActivity): void {
  const row = getRow(id);
  if (!row) return;
  const config = { ...json<IntegrationConfig>(row.config, {}), ...patch };
  getDb().prepare('UPDATE nc_integrations SET config = ? WHERE id = ?').run(JSON.stringify(config), id);
}

const stripSlash = (url: string | null | undefined) => (url ? url.replace(/\/+$/, '') : null);

export async function updateIntegration(id: string, patch: Partial<Omit<IntegrationInput, 'kind'>>): Promise<Integration> {
  const row = getRow(id);
  if (!row) throw notFound('Integration');
  const config = { ...json<IntegrationConfig>(row.config, {}) };
  if (row.kind === 'flow') {
    if (patch.flowUrl) config.flowUrl = stripSlash(patch.flowUrl);
    if (patch.flowToken) {
      await setSecret(secretPath(id), { [FLOW_TOKEN_KEY]: patch.flowToken });
      config.flowTokenSet = true;
    }
  } else {
    if (patch.umbrellaUrl !== undefined) config.umbrellaUrl = patch.umbrellaUrl;
    if (patch.inventoryUrl !== undefined) config.inventoryUrl = patch.inventoryUrl;
  }
  getDb()
    .prepare('UPDATE nc_integrations SET title = ?, active = ?, config = ? WHERE id = ?')
    .run(patch.title ?? row.title, patch.active === undefined ? row.active : patch.active ? 1 : 0, JSON.stringify(config), id);
  return getIntegration(id);
}

export async function deleteIntegration(id: string) {
  getDb().prepare('DELETE FROM nc_integrations WHERE id = ?').run(id);
  await deleteSecret(secretPath(id));
}

export async function rotateSecret(id: string): Promise<string> {
  const row = getRow(id);
  if (!row) throw notFound('Integration');
  const secret = newSecret();
  if (row.kind === 'flow') {
    // Flow keeps accepting the old secret until its admin pastes the new one: sign with both for a while.
    const previous = await getSecret(id).catch(() => null);
    await setSecret(secretPath(id), { [SECRET_KEY]: secret, [PREVIOUS_SECRET_KEY]: previous });
    const config = { ...json<IntegrationConfig>(row.config, {}), previousSecretUntil: new Date(Date.now() + ROTATION_GRACE_MS).toISOString() };
    getDb().prepare("UPDATE nc_integrations SET secret_enc = '', config = ? WHERE id = ?").run(JSON.stringify(config), id);
    return secret;
  }
  await setSecret(secretPath(id), { [SECRET_KEY]: secret });
  getDb().prepare("UPDATE nc_integrations SET secret_enc = '' WHERE id = ?").run(id);
  return secret;
}

/** Secrets Flow hooks are signed with: the current one, plus the previous one during the rotation grace period. */
export async function signingSecrets(id: string): Promise<string[]> {
  const row = getRow(id);
  if (!row) throw notFound('Integration');
  const secrets = [await getSecret(id)];
  const until = json<IntegrationConfig>(row.config, {}).previousSecretUntil;
  if (until && Date.parse(until) > Date.now()) {
    const previous = await readSecret(secretPath(id), PREVIOUS_SECRET_KEY);
    if (previous) secrets.push(previous);
  }
  return secrets;
}

/** The Flow API token of a `flow` integration (null when none is stored). */
export async function getFlowToken(id: string): Promise<string | null> {
  return readSecret(secretPath(id), FLOW_TOKEN_KEY);
}

export async function getSecret(id: string): Promise<string> {
  const row = getRow(id);
  if (!row) throw notFound('Integration');
  const stored = await readSecret(secretPath(id), SECRET_KEY);
  if (stored) return stored;
  if (!row.secret_enc) throw notFound('Integration secret');
  return decryptSecret(row.secret_enc);
}

/** Moves signing secrets that older versions kept in the integrations table into the secret store. */
export async function moveLegacySecrets(): Promise<number> {
  const rows = getDb().prepare("SELECT id, secret_enc FROM nc_integrations WHERE secret_enc <> ''").all() as { id: string; secret_enc: string }[];
  for (const r of rows) {
    await setSecret(secretPath(r.id), { [SECRET_KEY]: decryptSecret(r.secret_enc) });
    getDb().prepare("UPDATE nc_integrations SET secret_enc = '' WHERE id = ?").run(r.id);
  }
  return rows.length;
}

/** Titles of integrations by id (the secrets page names what each secret belongs to). */
export function integrationTitles(): Record<string, string> {
  const rows = getDb().prepare('SELECT id, title FROM nc_integrations').all() as { id: string; title: string }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.title]));
}
