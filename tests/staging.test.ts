// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('@/lib/staging-auth', () => ({ stagingEmail: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth', () => ({ validSessionToken: vi.fn(async () => false) }));
import { proxy } from '@/proxy';
import { stagingEmail } from '@/lib/staging-auth';

afterEach(() => { vi.unstubAllEnvs(); vi.mocked(stagingEmail).mockResolvedValue(undefined); });
describe('isolated staging', () => {
  it.each(['/api/cron/search', '/api/auth/google/start', '/api/auth/google/callback', '/api/search', '/api/import', '/api/career/sync', '/api/notifications/test', '/api/jobs/example/prepare'])('blocks %s before integration code can run', async (path) => {
    vi.stubEnv('APP_ENV', 'staging');
    vi.stubEnv('CRON_SECRET', 'accidentally-added-secret');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'accidentally-added-secret');
    const response = await proxy(new NextRequest(`https://test.rolebright.app${path}`));
    expect(response.status).toBe(503);
  });
  it('keeps private API routes protected', async () => {
    vi.stubEnv('APP_ENV', 'staging');
    vi.stubEnv('APP_SESSION_SECRET', 'test-only-secret');
    const response = await proxy(new NextRequest('https://test.rolebright.app/api/settings'));
    expect(response.status).toBe(403);
  });
  it('allows synthetic-data pages after verified Access authentication', async () => {
    vi.stubEnv('APP_ENV', 'staging');
    vi.mocked(stagingEmail).mockResolvedValue('tester@example.com');
    const response = await proxy(new NextRequest('https://test.rolebright.app/'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
  it('preserves production OAuth routing', async () => {
    vi.stubEnv('APP_ENV', 'production');
    const response = await proxy(new NextRequest('https://rolebright.app/api/auth/google/start'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
