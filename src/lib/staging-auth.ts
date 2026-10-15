import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

let cachedIssuer: string | undefined;
let cachedKeys: JWTVerifyGetKey | undefined;

export async function stagingEmail(token: string | null, keys?: JWTVerifyGetKey): Promise<string | undefined> {
  const issuer = process.env.CF_ACCESS_ISSUER;
  const audience = process.env.CF_ACCESS_AUD;
  const allowed = process.env.ALLOWED_LOGIN_EMAIL?.toLowerCase();
  if (process.env.APP_ENV !== 'staging' || !token || !issuer || !audience || !allowed) return undefined;
  try {
    if (!keys) {
      if (cachedIssuer !== issuer || !cachedKeys) {
        cachedKeys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
        cachedIssuer = issuer;
      }
      keys = cachedKeys;
    }
    const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'email'] });
    return typeof payload.email === 'string' && payload.email.toLowerCase() === allowed ? allowed : undefined;
  } catch {
    return undefined;
  }
}
