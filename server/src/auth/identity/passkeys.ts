/**
 * Passkeys (WebAuthn with user verification): Windows Hello (face, fingerprint, iris, PIN), Touch ID / Face ID,
 * Android biometrics and FIDO2 security keys. Settings key `identity.passkeys` ({enabled, rp_id}). When Inventory DB
 * is connected to Umbrella Identity and its address is inside the hub's passkey domain, the hub's domain is used and
 * the hub's passkeys are synchronized (docs/identity-federation.md).
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { randomBytes } from 'node:crypto';
import type { User } from '../../../../shared/src/index.js';
import { getDb, newId, now } from '../../db/index.js';
import { HttpError, badRequest, notFound } from '../../errors.js';
import { readSetting } from '../../system/settings.js';

export const PASSKEYS_KEY = 'identity.passkeys';
const MAX_PASSKEYS = 20;
const CEREMONY_TTL_MS = 5 * 60_000;

export interface PasskeySettings {
  enabled: boolean;
  rp_id: string;
}

export interface PasskeyRow {
  id: string;
  user_id: string;
  name: string;
  credential_id: string;
  public_key: string;
  user_handle: string;
  sign_count: number;
  aaguid: string;
  transports: string;
  backup_eligible: number;
  backup_state: number;
  hub_id: string | null;
  created_at: string;
  last_used_at: string | null;
}

export const passkeyView = (r: PasskeyRow) => ({
  id: r.id,
  name: r.name,
  transports: JSON.parse(r.transports || '[]') as string[],
  backup_eligible: !!r.backup_eligible,
  from_hub: !!r.hub_id,
  created_at: r.created_at,
  last_used_at: r.last_used_at,
});

export const hostWithin = (host: string, rpId: string) => {
  const h = host.toLowerCase();
  const r = rpId.toLowerCase();
  return !!r && (h === r || h.endsWith(`.${r}`));
};

/** The passkey setting in effect: the hub's when its passkeys are used here, else the local one. */
export function passkeyConfig(host?: string): PasskeySettings & { from_hub: boolean } {
  const local = { enabled: false, rp_id: '', ...readSetting<Partial<PasskeySettings>>(PASSKEYS_KEY, {}) };
  const u = readSetting<{ enabled?: boolean; sync_passkeys?: boolean; hub_passkeys?: PasskeySettings } | null>('identity.umbrella', null);
  const hub = u?.hub_passkeys;
  if (u?.enabled && u.sync_passkeys && hub?.enabled && hub.rp_id && (!host || hostWithin(host, hub.rp_id)))
    return { enabled: true, rp_id: hub.rp_id, from_hub: true };
  return { ...local, from_hub: false };
}

/** The relying party of a request: the page origin must be inside the passkey domain. */
function party(origin: string | undefined) {
  let url: URL;
  try {
    url = new URL(origin ?? '');
  } catch {
    throw new HttpError(400, 'PASSKEY_ORIGIN', 'This address is outside the passkey domain');
  }
  const cfg = passkeyConfig(url.hostname);
  if (!cfg.enabled) throw new HttpError(409, 'PASSKEYS_OFF', 'Passkeys are turned off');
  const rpID = cfg.rp_id || url.hostname;
  const local = url.hostname === 'localhost';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || !hostWithin(url.hostname, rpID))
    throw new HttpError(400, 'PASSKEY_ORIGIN', 'This address is outside the passkey domain');
  return { rpID, origin: url.origin };
}

interface Ceremony {
  challenge: string;
  rpID: string;
  origin: string;
  userId: string | null;
  expires: number;
}
const ceremonies = new Map<string, Ceremony>();

function remember(c: Omit<Ceremony, 'expires'>): string {
  const t = Date.now();
  for (const [k, v] of ceremonies) if (v.expires < t) ceremonies.delete(k);
  if (ceremonies.size > 10_000) ceremonies.clear();
  const id = randomBytes(18).toString('base64url');
  ceremonies.set(id, { ...c, expires: t + CEREMONY_TTL_MS });
  return id;
}

function take(id: string, userId: string | null): Ceremony {
  const c = ceremonies.get(id);
  ceremonies.delete(id);
  if (!c || c.expires < Date.now() || c.userId !== userId) throw new HttpError(400, 'PASSKEY_EXPIRED', 'The passkey request has expired: try again');
  return c;
}

const handleOf = (userId: string) => Buffer.from(`idb:${userId}`).toString('base64url');

export function listPasskeys(userId: string): PasskeyRow[] {
  return getDb().prepare('SELECT * FROM nc_passkeys WHERE user_id = ? ORDER BY created_at DESC').all(userId) as PasskeyRow[];
}

export async function beginRegistration(user: User, origin: string | undefined) {
  const p = party(origin);
  if (passkeyConfig().from_hub && sourceOf(user.id) === 'umbrella')
    throw new HttpError(409, 'PASSKEYS_HUB', 'Your passkeys come from Umbrella Monitoring: add them in your Umbrella profile');
  const keys = listPasskeys(user.id);
  if (keys.length >= MAX_PASSKEYS) throw new HttpError(409, 'PASSKEY_LIMIT', 'Too many passkeys');
  const options = await generateRegistrationOptions({
    rpName: 'Inventory DB',
    rpID: p.rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: new Uint8Array(Buffer.from(`idb:${user.id}`)),
    attestationType: 'none',
    excludeCredentials: keys.map((k) => ({ id: k.credential_id, transports: JSON.parse(k.transports) as AuthenticatorTransportFuture[] })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  return { ceremony: remember({ challenge: options.challenge, rpID: p.rpID, origin: p.origin, userId: user.id }), options: { publicKey: options } };
}

const sourceOf = (userId: string) => (getDb().prepare('SELECT source FROM nc_users WHERE id = ?').get(userId) as { source: string } | undefined)?.source;

const KNOWN: Record<string, string> = {
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  'cb69481e-8ff7-4039-93ec-0a2729a154a8': 'YubiKey 5',
  'ee882879-721c-4913-9775-3dfcce97072a': 'YubiKey 5',
  'fa2b99dc-9e39-4257-8f92-4a30d23c4118': 'YubiKey 5 NFC',
};

function defaultName(aaguid: string, transports: string[]) {
  if (KNOWN[aaguid]) return KNOWN[aaguid];
  if (transports.some((t) => ['usb', 'nfc', 'ble'].includes(t))) return 'Security key';
  if (transports.includes('hybrid')) return 'Phone';
  return 'Passkey';
}

export async function finishRegistration(user: User, ceremony: string, credential: unknown, name?: string) {
  const c = take(ceremony, user.id);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: credential as Parameters<typeof verifyRegistrationResponse>[0]['response'],
      expectedChallenge: c.challenge,
      expectedOrigin: c.origin,
      expectedRPID: c.rpID,
      requireUserVerification: true,
    });
  } catch (e) {
    throw new HttpError(400, 'PASSKEY_FAILED', `The passkey could not be verified: ${(e as Error).message}`);
  }
  if (!v.verified || !v.registrationInfo) throw new HttpError(400, 'PASSKEY_FAILED', 'The passkey could not be verified');
  const info = v.registrationInfo;
  const transports = (info.credential.transports ?? []) as string[];
  const row: PasskeyRow = {
    id: newId('pk'),
    user_id: user.id,
    name: (name ?? '').trim().slice(0, 64) || defaultName(info.aaguid, transports),
    credential_id: info.credential.id,
    public_key: Buffer.from(info.credential.publicKey).toString('base64url'),
    user_handle: handleOf(user.id),
    sign_count: info.credential.counter,
    aaguid: info.aaguid,
    transports: JSON.stringify(transports),
    backup_eligible: info.credentialDeviceType === 'multiDevice' ? 1 : 0,
    backup_state: info.credentialBackedUp ? 1 : 0,
    hub_id: null,
    created_at: now(),
    last_used_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO nc_passkeys (id, user_id, name, credential_id, public_key, user_handle, sign_count, aaguid, transports, backup_eligible,
        backup_state, hub_id, created_at, last_used_at)
       VALUES (@id, @user_id, @name, @credential_id, @public_key, @user_handle, @sign_count, @aaguid, @transports, @backup_eligible,
        @backup_state, @hub_id, @created_at, @last_used_at)`,
    )
    .run(row);
  return passkeyView(row);
}

export async function beginSignIn(origin: string | undefined) {
  const p = party(origin);
  const options = await generateAuthenticationOptions({ rpID: p.rpID, userVerification: 'required', allowCredentials: [] });
  return { ceremony: remember({ challenge: options.challenge, rpID: p.rpID, origin: p.origin, userId: null }), options: { publicKey: options } };
}

/** Verifies a passkey sign-in and returns the user ID. */
export async function finishSignIn(ceremony: string, credential: { id?: string; response?: { userHandle?: string } }): Promise<{ userId: string; name: string }> {
  const c = take(ceremony, null);
  const row = getDb().prepare('SELECT * FROM nc_passkeys WHERE credential_id = ?').get(credential?.id ?? '') as PasskeyRow | undefined;
  if (!row || (credential.response?.userHandle && credential.response.userHandle !== row.user_handle))
    throw new HttpError(401, 'PASSKEY_FAILED', 'This passkey is not registered');
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: credential as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
      expectedChallenge: c.challenge,
      expectedOrigin: c.origin,
      expectedRPID: c.rpID,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
        counter: Number(row.sign_count),
        transports: JSON.parse(row.transports) as AuthenticatorTransportFuture[],
      },
      requireUserVerification: true,
    });
  } catch (e) {
    throw new HttpError(401, 'PASSKEY_FAILED', `The passkey could not be verified: ${(e as Error).message}`);
  }
  if (!v.verified || !v.authenticationInfo.userVerified) throw new HttpError(401, 'PASSKEY_FAILED', 'The passkey could not be verified');
  getDb()
    .prepare('UPDATE nc_passkeys SET sign_count = ?, backup_state = ?, last_used_at = ? WHERE id = ?')
    .run(v.authenticationInfo.newCounter, v.authenticationInfo.credentialBackedUp ? 1 : 0, now(), row.id);
  return { userId: row.user_id, name: row.name };
}

export function renamePasskey(userId: string, id: string, name: string) {
  const n = name.trim().slice(0, 64);
  if (!n) throw badRequest('Enter a name');
  const r = getDb().prepare('UPDATE nc_passkeys SET name = ? WHERE id = ? AND user_id = ? AND hub_id IS NULL').run(n, id, userId);
  if (!r.changes) throw notFound('Passkey');
}

export function removePasskey(userId: string, id?: string) {
  const db = getDb();
  return id
    ? db.prepare('DELETE FROM nc_passkeys WHERE id = ? AND user_id = ?').run(id, userId).changes
    : db.prepare('DELETE FROM nc_passkeys WHERE user_id = ?').run(userId).changes;
}

/** Replaces the passkeys of a user synchronized from the hub. */
export function replaceHubPasskeys(
  userId: string,
  keys: { id: string; name: string; credential_id: string; public_key: string; user_handle: string; sign_count: number; aaguid: string; transports: string[]; backup_eligible: boolean; created_at: string }[],
) {
  const db = getDb();
  db.prepare('DELETE FROM nc_passkeys WHERE user_id = ? AND hub_id IS NOT NULL').run(userId);
  for (const k of keys) {
    db.prepare(
      `INSERT INTO nc_passkeys (id, user_id, name, credential_id, public_key, user_handle, sign_count, aaguid, transports, backup_eligible, hub_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (credential_id) DO NOTHING`,
    ).run(newId('pk'), userId, k.name, k.credential_id, k.public_key, k.user_handle, k.sign_count, k.aaguid, JSON.stringify(k.transports ?? []), k.backup_eligible ? 1 : 0, k.id, k.created_at || now());
  }
}
