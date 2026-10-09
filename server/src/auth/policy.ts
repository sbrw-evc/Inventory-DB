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
