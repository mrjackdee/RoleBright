// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('node:fs/promises', () => ({ default: { readFile: vi.fn(async () => JSON.stringify({ jobs: [{ id: 'synthetic-only' }] })) } }));
const external = vi.hoisted(() => vi.fn(() => { throw new Error('An external client was reached'); }));
vi.mock('googleapis', () => ({ google: { auth: { OAuth2: external, JWT: external }, drive: external, gmail: external } }));
import { googleAuth, googleConfigured } from '@/lib/storage/google';
import { loadGoogleUserRefreshToken, saveGoogleUserRefreshToken } from '@/lib/google-user-token';
import { notificationsConfigured, sendNotification } from '@/lib/notifications';
import { getState } from '@/lib/storage/state';
import { discoverAll } from '@/lib/job-sources';
import { runSearch } from '@/lib/search-service';
import { prepareApplication } from '@/lib/package-service';
import { buildCareerEvidenceProfile } from '@/lib/ai';

beforeEach(() => {
  vi.stubEnv('APP_ENV', 'staging');
  for (const key of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_USER_REFRESH_TOKEN', 'GOOGLE_DRIVE_ROOT_FOLDER_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'APP_SESSION_SECRET', 'NOTIFICATION_EMAIL', 'SERPAPI_KEY', 'AI_GATEWAY_API_KEY', 'CRON_SECRET']) vi.stubEnv(key, 'accidentally-added-test-credential');
  external.mockClear();
  vi.stubGlobal('fetch', external);
});
afterEach(() => { expect(external).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('staging with accidentally supplied credentials', () => {
  it('fails closed without database mode even when Drive credentials are present', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('USE_LOCAL_STATE', 'false');
    vi.stubEnv('STAGING_STORAGE', '');
    await expect(getState()).rejects.toThrow('STAGING_STORAGE=mysql');
  });
  it('blocks scheduled searches at the service boundary', async () => await expect(runSearch('MORNING')).rejects.toThrow('disabled'));
  it('blocks application preparation at the service boundary', async () => await expect(prepareApplication('synthetic-job')).rejects.toThrow('disabled'));
  it('blocks paid AI calls', async () => await expect(buildCareerEvidenceProfile([])).rejects.toThrow('disabled'));
  it('does not expose Google Drive as configured', () => expect(googleConfigured()).toBe(false));
  it('blocks Drive authentication', async () => await expect(googleAuth()).rejects.toThrow('disabled'));
  it('blocks loading even an explicitly supplied refresh token', async () => await expect(loadGoogleUserRefreshToken()).rejects.toThrow('disabled'));
  it('blocks writing tokens to Drive', async () => await expect(saveGoogleUserRefreshToken('test-token')).rejects.toThrow('disabled'));
  it('does not expose notification delivery as configured', () => expect(notificationsConfigured()).toBe(false));
  it('blocks actual email delivery before client initialization', async () => await expect(sendNotification('Test', 'Synthetic body')).rejects.toThrow('disabled'));
  it('blocks job discovery before any provider request', async () => await expect(discoverAll()).rejects.toThrow('disabled'));
});
