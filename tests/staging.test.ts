// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@/lib/auth', () => ({ validSessionToken: vi.fn(async () => false) }));
import { proxy } from '@/proxy';

afterEach(() => vi.unstubAllEnvs());
describe('isolated staging', () => {
  it.each(['/api/cron/search', '/api/auth/google/start', '/api/auth/google/callback'])('blocks %s before integration code can run', async (path) => {
    vi.stubEnv('APP_ENV', 'staging');
    const response = await proxy(new NextRequest(`https://test.rolebright.app${path}`));
    expect(response.status).toBe(503);
  });
  it('keeps private API routes protected', async () => {
    vi.stubEnv('APP_ENV', 'staging');
    vi.stubEnv('APP_SESSION_SECRET', 'test-only-secret');
    const response = await proxy(new NextRequest('https://test.rolebright.app/api/settings'));
    expect(response.status).toBe(401);
  });
  it('preserves production OAuth routing', async () => {
    vi.stubEnv('APP_ENV', 'production');
    const response = await proxy(new NextRequest('https://rolebright.app/api/auth/google/start'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
