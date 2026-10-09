import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Integration secrets must be readable (HMAC needs the plain secret on both sides), so they are stored
 * encrypted with AES-256-GCM under `INTEGRATION_KEY` (falls back to `JWT_SECRET`).
 */
const key = () =>
  createHash('sha256')
    .update(process.env.INTEGRATION_KEY || process.env.JWT_SECRET || 'dev-only-secret-change-me')
    .digest();

export const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(stored: string): string {
  const [iv, tag, data] = stored.split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** `v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`, the scheme Umbrella's HTTP block signs with. */
export function sign(secret: string, timestamp: string, rawBody: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

export const SIGNATURE_TOLERANCE_SEC = 300;

export function verifySignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSec - Number(timestamp)) > SIGNATURE_TOLERANCE_SEC) return false;
  const expected = Buffer.from(sign(secret, timestamp, rawBody));
  // A header may carry several signatures (secret rotation): `v1=aaa,v1=bbb`.
  return signature.split(',').some((s) => {
    const got = Buffer.from(s.trim());
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
