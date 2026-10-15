import bcrypt from 'bcryptjs';
import { checkPassword, normalizePolicy, passwordExpiresAt, policyError, type PasswordPolicy } from '../../../shared/src/passwordPolicy.js';
import { getDb } from '../db/index.js';
import { HttpError, badRequest } from '../errors.js';
import { readSetting, writeSetting } from '../system/settings.js';

const KEY = 'password_policy';

export function getPolicy(): PasswordPolicy {
  return normalizePolicy(readSetting<Partial<PasswordPolicy> | null>(KEY, null));
}

export function savePolicy(p: PasswordPolicy, userId: string): PasswordPolicy {
  const problem = policyError(p);
  if (problem) throw badRequest('Invalid password policy', { problem });
  writeSetting(KEY, p, userId);
  return getPolicy();
}

/** Rejects a new password that breaks the policy; `details.violations` lists the rules. */
export function assertPasswordAllowed(password: string, login: string) {
  const violations = checkPassword(password, login, getPolicy());
  if (violations.length) throw new HttpError(400, 'PASSWORD_POLICY', 'The password does not meet the password policy', { violations });
}

export function isExpired(changedAt: string | null, policy = getPolicy(), at = Date.now()): boolean {
  const expires = passwordExpiresAt(changedAt, policy);
  return !!expires && Date.parse(expires) <= at;
}

/** Local accounts with an expired password and those inside the warning window. */
export function policySummary(policy = getPolicy()) {
  const rows = getDb().prepare("SELECT password_changed_at FROM nc_users WHERE source = 'local' AND disabled = 0").all() as { password_changed_at: string | null }[];
  let expired = 0;
  let expiring = 0;
  const now = Date.now();
  for (const r of rows) {
    const exp = passwordExpiresAt(r.password_changed_at, policy);
    if (!exp) continue;
    const t = Date.parse(exp);
    if (t <= now) expired++;
    else if (policy.warn_days && t - now <= policy.warn_days * 86_400_000) expiring++;
  }
  return { policy, local_users: rows.length, expired_users: expired, expiring_users: expiring };
}

/** The policy is managed by Umbrella Identity (copied from the hub at every synchronization). */
export function policyManaged(): boolean {
  const u = readSetting<{ enabled?: boolean; sync_policy?: boolean } | null>('identity.umbrella', null);
  return !!u?.enabled && !!u?.sync_policy;
}

/** Rejects a password that is the current one or one of the remembered previous ones. */
export async function assertNotReused(userId: string, password: string, currentHash: string) {
  const keep = getPolicy().history_count;
  const old = keep
    ? (getDb().prepare('SELECT hash FROM nc_password_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, keep) as { hash: string }[])
    : [];
  for (const h of [currentHash, ...old.map((o) => o.hash)].slice(0, Math.max(keep, 1))) {
    if (h && (await bcrypt.compare(password, h)))
      throw new HttpError(400, 'PASSWORD_POLICY', 'The password was used before', { violations: ['history'] });
  }
}

/** Remembers a replaced password hash, keeping as many as the policy asks. */
export function rememberPassword(userId: string, hash: string, at: string) {
  const keep = getPolicy().history_count;
  if (!keep || !hash) return;
  const db = getDb();
  db.prepare('INSERT INTO nc_password_history (user_id, hash, created_at) VALUES (?, ?, ?)').run(userId, hash, at);
  db.prepare(
    `DELETE FROM nc_password_history WHERE user_id = ? AND created_at NOT IN
       (SELECT created_at FROM nc_password_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`,
  ).run(userId, userId, keep);
}

// Lockout: wrong passwords in a row for one login lock it for the policy's minutes (the built-in limit: 10 / 15 min).
const failures = new Map<string, { n: number; until: number }>();

export function assertNotLocked(login: string) {
  const f = failures.get(login.toLowerCase());
  if (f && f.until > Date.now()) {
    const minutes = Math.ceil((f.until - Date.now()) / 60_000);
    throw new HttpError(429, 'TOO_MANY_ATTEMPTS', `Too many failed sign-ins. Try again in ${minutes} min.`);
  }
}

export function signInFailed(login: string) {
  const p = getPolicy();
  const max = p.lockout_attempts || 10;
  const minutes = p.lockout_attempts ? p.lockout_minutes : 15;
  const key = login.toLowerCase();
  const f = failures.get(key) ?? { n: 0, until: 0 };
  f.n++;
  if (f.n >= max) {
    f.until = Date.now() + minutes * 60_000;
    f.n = 0;
  }
  failures.set(key, f);
  if (failures.size > 50_000) failures.clear();
}

export function signInSucceeded(login: string) {
  failures.delete(login.toLowerCase());
}
