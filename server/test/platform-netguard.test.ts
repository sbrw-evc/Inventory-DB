import { afterEach, describe, expect, it } from 'vitest';
import { assertPublicUrl, isBlockedAddress } from '../src/platform/netguard.js';

describe('webhook network guard', () => {
  const saved = process.env.WEBHOOK_ALLOW_PRIVATE;
  afterEach(() => {
    process.env.WEBHOOK_ALLOW_PRIVATE = saved;
  });

  it('classifies internal addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('refuses internal targets unless explicitly allowed', async () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    await expect(assertPublicUrl('http://127.0.0.1:8080/hook')).rejects.toThrow(/private or internal/);
    await expect(assertPublicUrl('http://[::1]/hook')).rejects.toThrow(/private or internal/);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private or internal/);
    await expect(assertPublicUrl('ftp://example.com/x')).rejects.toThrow(/http and https/);
    await expect(assertPublicUrl('http://93.184.215.14/hook')).resolves.toBeUndefined();

    process.env.WEBHOOK_ALLOW_PRIVATE = '1';
    await expect(assertPublicUrl('http://127.0.0.1:8080/hook')).resolves.toBeUndefined();
  });
});
