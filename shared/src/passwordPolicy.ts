/**
 * Password policy for local accounts, the same rules as Umbrella's: length, digits, special characters, mixed case,
 * allowed alphabets and maximum age. Checked by the server on sign-up and password change, and by the web app for
 * the live checklist next to a password field.
 */
export type PolicyLetters = 'latin' | 'cyrillic' | 'latin_cyrillic' | 'any';

export interface PasswordPolicy {
  min_length: number;
  require_digits: boolean;
  min_digits: number;
  require_special: boolean;
  min_special: number;
  require_mixed_case: boolean;
  letters: PolicyLetters;
  /** Days a password stays valid; 0 = never expires. */
  max_age_days: number;
  /** Days before expiry when the user is warned; 0 = no warning. */
  warn_days: number;
}

export type PolicyViolation = 'length' | 'digits' | 'special' | 'mixed_case' | 'letters' | 'username' | 'control';
export type PolicyProblem = 'length' | 'digits' | 'special' | 'fit' | 'max_age' | 'warn';

export const POLICY_LETTERS: PolicyLetters[] = ['latin', 'cyrillic', 'latin_cyrillic', 'any'];
export const MAX_AGE_DAYS = 3650;
export const MAX_WARN_DAYS = 90;
/** Longest password accepted (bytes of UTF-8); bcrypt only reads the first 72. */
export const MAX_PASSWORD_BYTES = 256;

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  min_length: 12,
  require_digits: true,
  min_digits: 1,
  require_special: true,
  min_special: 1,
  require_mixed_case: true,
  letters: 'latin',
  max_age_days: 0,
  warn_days: 0,
};

const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
const SPECIAL = /[\p{P}\p{S}]/u;
const CONTROL = /\p{Cc}/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const SCRIPT: Record<PolicyLetters, RegExp | null> = {
  latin: /\p{Script=Latin}/u,
  cyrillic: /\p{Script=Cyrillic}/u,
  latin_cyrillic: /[\p{Script=Latin}\p{Script=Cyrillic}]/u,
  any: null,
};

const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Why a policy cannot be saved, or null when it is valid. */
export function policyError(p: PasswordPolicy): PolicyProblem | null {
  if (!int(p.min_length, 8, 128)) return 'length';
  if (p.require_digits && !int(p.min_digits, 1, 16)) return 'digits';
  if (p.require_special && !int(p.min_special, 1, 16)) return 'special';
  const need = (p.require_digits ? p.min_digits : 0) + (p.require_special ? p.min_special : 0) + (p.require_mixed_case ? 2 : 0);
  if (need > p.min_length) return 'fit';
  if (!int(p.max_age_days, 0, MAX_AGE_DAYS)) return 'max_age';
  if (p.max_age_days > 0 && (!int(p.warn_days, 0, MAX_WARN_DAYS) || p.warn_days >= p.max_age_days)) return 'warn';
  return null;
}

/** The rules a password breaks. `username` is the login (email) the password must differ from. */
export function checkPassword(password: string, username: string, p: PasswordPolicy): PolicyViolation[] {
  const out = new Set<PolicyViolation>();
  const chars = [...password];
  if (chars.length < p.min_length || new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) out.add('length');
  let digits = 0;
  let special = 0;
  let upper = false;
  let lower = false;
  for (const ch of chars) {
    if (CONTROL.test(ch)) out.add('control');
    else if (DIGIT.test(ch)) digits++;
    else if (LETTER.test(ch)) {
      const allowed = SCRIPT[p.letters];
      if (allowed && !allowed.test(ch)) out.add('letters');
      upper ||= UPPER.test(ch);
      lower ||= LOWER.test(ch);
    } else if (SPECIAL.test(ch)) special++;
  }
  if (p.require_digits && digits < p.min_digits) out.add('digits');
  if (p.require_special && special < p.min_special) out.add('special');
  if (p.require_mixed_case && (!upper || !lower)) out.add('mixed_case');
  if (username) {
    const lowered = password.toLowerCase();
    const login = username.toLowerCase();
    if (lowered === login || lowered === login.split('@')[0]) out.add('username');
  }
  return [...out];
}

/** The rules a policy shows in a checklist, in display order. */
export function policyRules(p: PasswordPolicy): PolicyViolation[] {
  const r: PolicyViolation[] = ['length'];
  if (p.require_digits) r.push('digits');
  if (p.require_special) r.push('special');
  if (p.require_mixed_case) r.push('mixed_case');
  if (p.letters !== 'any') r.push('letters');
  r.push('username');
  return r;
}

/** When a password set at `changedAt` expires under `p` (ISO), or null when passwords do not expire. */
export function passwordExpiresAt(changedAt: string | null | undefined, p: PasswordPolicy): string | null {
  if (!p.max_age_days || !changedAt) return null;
  const at = Date.parse(changedAt);
  if (Number.isNaN(at)) return null;
  return new Date(at + p.max_age_days * 86_400_000).toISOString();
}

/** Fills missing or malformed fields of a stored policy with the defaults. */
export function normalizePolicy(v: Partial<PasswordPolicy> | null | undefined): PasswordPolicy {
  const p = { ...DEFAULT_PASSWORD_POLICY, ...(v ?? {}) };
  if (!POLICY_LETTERS.includes(p.letters)) p.letters = DEFAULT_PASSWORD_POLICY.letters;
  return p;
}
