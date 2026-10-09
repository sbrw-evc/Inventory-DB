/** Password policy: validation, sign-up, expiry and changing the password. */
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkPassword, DEFAULT_PASSWORD_POLICY, policyError } from '../../shared/src/passwordPolicy.js';
import { getDb } from '../src/db/index.js';
import { createTestApp, signUpUser } from './helpers.js';

let app: FastifyInstance;
let admin: Record<string, string>;

const inject = (method: string, url: string, payload?: unknown, headers?: Record<string, string>) =>
  app.inject({ method: method as 'GET', url: `/api/v1${url}`, payload: payload as object, headers });

beforeAll(async () => {
  app = await createTestApp();
  admin = (await signUpUser(app, 'admin@example.com')).headers;
  await inject('GET', '/settings/password-policy', undefined, admin);
});

describe('password policy rules', () => {
  it('checks length, digits, special characters, case, alphabet and the login', () => {
    const p = DEFAULT_PASSWORD_POLICY;
    expect(checkPassword('Short-1', 'a@b.c', p)).toEqual(['length']);
    expect(checkPassword('longpassword', '', p).sort()).toEqual(['digits', 'mixed_case', 'special']);
    expect(checkPassword('Пароль-123456', '', p)).toEqual(['letters']);
    expect(checkPassword('Пароль-123456', '', { ...p, letters: 'cyrillic' })).toEqual([]);
    expect(checkPassword('John.Smith-1', 'john.smith-1@example.com', p)).toEqual(['username']);
    expect(checkPassword('Good-Password-1', 'a@b.c', p)).toEqual([]);
  });

  it('rejects policies that cannot be met', () => {
    expect(policyError(DEFAULT_PASSWORD_POLICY)).toBeNull();
    expect(policyError({ ...DEFAULT_PASSWORD_POLICY, min_length: 6 })).toBe('length');
    expect(policyError({ ...DEFAULT_PASSWORD_POLICY, min_length: 8, min_digits: 4, min_special: 4 })).toBe('fit');
    expect(policyError({ ...DEFAULT_PASSWORD_POLICY, max_age_days: 30, warn_days: 30 })).toBe('warn');
  });
});

describe('password policy settings', () => {
  it('rejects a sign-up password that breaks the policy, with the broken rules', async () => {
    const res = await inject('POST', '/auth/signup', { email: 'weak@example.com', password: 'password' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'PASSWORD_POLICY', details: { violations: expect.arrayContaining(['length', 'digits']) } });
  });

  it('lets an admin read and change the policy; others cannot', async () => {
    const view = (await inject('GET', '/settings/password-policy', undefined, admin)).json();
    expect(view).toMatchObject({ policy: DEFAULT_PASSWORD_POLICY, local_users: 1, expired_users: 0 });
    const other = (await signUpUser(app)).headers;
    expect((await inject('GET', '/settings/password-policy', undefined, other)).statusCode).toBe(403);
    expect((await inject('PUT', '/settings/password-policy', { ...DEFAULT_PASSWORD_POLICY, min_length: 4 }, admin)).statusCode).toBe(400);
    const saved = await inject('PUT', '/settings/password-policy', { ...DEFAULT_PASSWORD_POLICY, min_length: 10, require_special: false, max_age_days: 90, warn_days: 14 }, admin);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().policy).toMatchObject({ min_length: 10, require_special: false, max_age_days: 90 });
    expect((await inject('POST', '/auth/signup', { email: 'nospecial@example.com', password: 'NoSpecial12' })).statusCode).toBe(200);
  });

  it('asks for a new password once it has expired, and accepts one that meets the policy', async () => {
    await signUpUser(app, 'old@example.com');
    getDb().prepare("UPDATE nc_users SET password_changed_at = '2020-01-01T00:00:00.000Z' WHERE email = 'old@example.com'").run();
    const expired = await inject('POST', '/auth/signin', { email: 'old@example.com', password: 'Password-123!' });
    expect(expired.statusCode).toBe(403);
    expect(expired.json().error).toBe('PASSWORD_EXPIRED');
    expect((await inject('GET', '/settings/password-policy', undefined, admin)).json().expired_users).toBe(1);

    const weak = await inject('POST', '/auth/password', { email: 'old@example.com', password: 'Password-123!', newPassword: 'short' });
    expect(weak.json().error).toBe('PASSWORD_POLICY');
    const same = await inject('POST', '/auth/password', { email: 'old@example.com', password: 'Password-123!', newPassword: 'Password-123!' });
    expect(same.json().error).toBe('PASSWORD_REUSED');
    const wrong = await inject('POST', '/auth/password', { email: 'old@example.com', password: 'nope', newPassword: 'Brand-New-Pass1' });
    expect(wrong.statusCode).toBe(401);
    const ok = await inject('POST', '/auth/password', { email: 'old@example.com', password: 'Password-123!', newPassword: 'Brand-New-Pass1' });
    expect(ok.statusCode).toBe(200);
    expect((await inject('POST', '/auth/signin', { email: 'old@example.com', password: 'Brand-New-Pass1' })).statusCode).toBe(200);

    const me = (await inject('GET', '/auth/me', undefined, { authorization: `Bearer ${ok.json().token}` })).json();
    expect(me.account).toMatchObject({ source: 'local', admin: false, passwordExpiresSoon: false });
    expect(Date.parse(me.account.passwordExpiresAt)).toBeGreaterThan(Date.now() + 80 * 86_400_000);
  });

  it('locks out disabled accounts, including their open sessions', async () => {
    const { headers } = await signUpUser(app, 'gone@example.com');
    getDb().prepare("UPDATE nc_users SET disabled = 1 WHERE email = 'gone@example.com'").run();
    expect((await inject('GET', '/auth/me', undefined, headers)).statusCode).toBe(401);
    const res = await inject('POST', '/auth/signin', { email: 'gone@example.com', password: 'Password-123!' });
    expect(res.json().error).toBe('ACCOUNT_DISABLED');
  });
});
