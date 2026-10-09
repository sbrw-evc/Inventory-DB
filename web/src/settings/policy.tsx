import { CheckCircle2, Circle } from 'lucide-react';
import { motion } from 'motion/react';
import { checkPassword, policyRules, type PasswordPolicy, type PolicyLetters, type PolicyProblem, type PolicyViolation } from '@shared';
import { t } from '../i18n';

export function lettersText(l: PolicyLetters) {
  return { latin: t('Latin only'), cyrillic: t('Cyrillic only'), latin_cyrillic: t('Latin and Cyrillic'), any: t('any alphabet') }[l];
}

export function ruleText(rule: PolicyViolation, p: PasswordPolicy) {
  switch (rule) {
    case 'length':
      return t('At least {n} characters', { n: p.min_length });
    case 'digits':
      return t('At least {n} digits', { n: p.min_digits });
    case 'special':
      return t('At least {n} special characters (! @ # - _ …)', { n: p.min_special });
    case 'mixed_case':
      return t('Upper and lower case letters');
    case 'letters':
      return t('Letters: {letters}', { letters: lettersText(p.letters) });
    case 'username':
      return t('Differs from the login');
    case 'control':
      return t('No control characters');
  }
}

export function problemText(p: PolicyProblem) {
  return {
    length: t('The minimum length must be from 8 to 128 characters.'),
    digits: t('The number of digits must be from 1 to 16.'),
    special: t('The number of special characters must be from 1 to 16.'),
    fit: t('The required digits, special characters and letters do not fit into the minimum length.'),
    max_age: t('The password lifetime must be from 0 to 3650 days.'),
    warn: t('The warning must come from 0 to 90 days before expiry and earlier than the lifetime.'),
  }[p];
}

export function expiryText(p: PasswordPolicy) {
  if (!p.max_age_days) return t('Never expire');
  const days = t('{n} days', { n: p.max_age_days });
  return p.warn_days ? `${days}, ${t('warn {n} days before', { n: p.warn_days })}` : days;
}

/** Live checklist of the rules next to a new password field (Umbrella PolicyChecklist). */
export function PolicyChecklist({ policy, password, login, confirm }: { policy: PasswordPolicy; password: string; login: string; confirm?: string }) {
  const failed = new Set(checkPassword(password, login, policy));
  const items = policyRules(policy).map((r) => ({ key: r, text: ruleText(r, policy), ok: password !== '' && !failed.has(r) }));
  if (failed.has('control')) items.push({ key: 'control', text: ruleText('control', policy), ok: false });
  if (confirm !== undefined) items.push({ key: 'username', text: t('Passwords match'), ok: password !== '' && password === confirm });
  return (
    <ul className="checklist">
      {items.map((i, n) => (
        <li key={`${i.key}-${n}`} className={i.ok ? 'ok' : ''}>
          {i.ok ? (
            <motion.span style={{ display: 'inline-flex' }} initial={{ scale: 0.3 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 520, damping: 18 }}>
              <CheckCircle2 size={16} />
            </motion.span>
          ) : (
            <Circle size={16} />
          )}
          {i.text}
        </li>
      ))}
    </ul>
  );
}
