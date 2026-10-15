// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { stagingEmail } from '@/lib/staging-auth';
let privateKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test' }] });
});
beforeEach(() => {
  vi.stubEnv('APP_ENV', 'staging');
  vi.stubEnv('CF_ACCESS_ISSUER', 'https://test.cloudflareaccess.com');
  vi.stubEnv('CF_ACCESS_AUD', 'staging-audience');
  vi.stubEnv('ALLOWED_LOGIN_EMAIL', 'tester@example.com');
});
afterEach(() => vi.unstubAllEnvs());
async function token(email = 'tester@example.com', audience = 'staging-audience', expiry = '1h', issuer = 'https://test.cloudflareaccess.com') {
  return new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuedAt().setIssuer(issuer).setAudience(audience).setExpirationTime(expiry).sign(privateKey);
}
describe('staging Access token validation', () => {
  it('accepts a signed token for the owner and this application', async () => {
    expect(await stagingEmail(await token(), keys)).toBe('tester@example.com');
  });
  it('rejects another email', async () => expect(await stagingEmail(await token('other@example.com'), keys)).toBeUndefined());
  it('rejects another application', async () => expect(await stagingEmail(await token(undefined, 'production-audience'), keys)).toBeUndefined());
  it('rejects another issuer', async () => expect(await stagingEmail(await token(undefined, undefined, '1h', 'https://other.cloudflareaccess.com'), keys)).toBeUndefined());
  it('rejects expired tokens', async () => expect(await stagingEmail(await token(undefined, undefined, '-1h'), keys)).toBeUndefined());
  it('rejects forged tokens', async () => {
    const signed = await token();
    const parts = signed.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    expect(await stagingEmail(parts.join('.'), keys)).toBeUndefined();
  });
  it('fails closed without configuration', async () => {
    vi.stubEnv('CF_ACCESS_AUD', '');
    expect(await stagingEmail(await token(), keys)).toBeUndefined();
  });
  it('cannot authenticate production', async () => {
    vi.stubEnv('APP_ENV', 'production');
    expect(await stagingEmail(await token(), keys)).toBeUndefined();
  });
});
