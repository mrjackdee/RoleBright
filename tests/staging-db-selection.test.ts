// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ pool: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), download: vi.fn(), upload: vi.fn(), find: vi.fn() }));
vi.mock('mysql2/promise', () => ({ createPool: mocks.pool }));
vi.mock('node:fs/promises', () => ({ default: { readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: vi.fn() } }));
vi.mock('@/lib/storage/google', () => ({ googleConfigured: () => true, findFileByName: mocks.find, downloadFile: mocks.download, uploadBuffer: mocks.upload }));
import { getState, saveState, updateState } from '@/lib/storage/state';
import { createStagingState } from '@/lib/staging-state';
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('USE_LOCAL_STATE', 'false'); });
afterEach(() => vi.unstubAllEnvs());
describe('storage selection with mocked clients', () => {
  it.each(['', 'mysql'])('denies incomplete staging mode %s before any client or filesystem', async mode => {
    vi.stubEnv('APP_ENV', 'staging'); vi.stubEnv('STAGING_STORAGE', mode); vi.stubEnv('DB_HOST', ''); vi.stubEnv('USE_LOCAL_STATE', 'true');
    const mutate = vi.fn(); await expect(getState()).rejects.toThrow(); await expect(saveState(createStagingState())).rejects.toThrow(); await expect(updateState(mutate)).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled(); expect(mocks.pool).not.toHaveBeenCalled(); expect(mocks.find).not.toHaveBeenCalled(); expect(mocks.readFile).not.toHaveBeenCalled(); expect(mocks.writeFile).not.toHaveBeenCalled();
  });
  it('does not fall back when configured database acquisition fails', async () => {
    for (const [key, value] of Object.entries({ APP_ENV: 'staging', STAGING_STORAGE: 'mysql', DB_HOST: 'db.invalid', DB_NAME: 'test_staging', DB_USER: 'fake', DB_PASSWORD: 'fake', DB_TLS: 'required' })) vi.stubEnv(key, value);
    mocks.pool.mockReturnValue({ getConnection: vi.fn(async () => { throw new Error('fake network failure'); }) });
    await expect(getState()).rejects.toThrow('unavailable'); expect(mocks.find).not.toHaveBeenCalled(); expect(mocks.readFile).not.toHaveBeenCalled();
  });
  it('preserves production Drive reads, updates and saves, ignoring staging mode', async () => {
    vi.stubEnv('APP_ENV', 'production'); vi.stubEnv('STAGING_STORAGE', 'mysql'); vi.stubEnv('GOOGLE_DRIVE_ROOT_FOLDER_ID', 'mock-root');
    const state = createStagingState(); mocks.find.mockResolvedValue({ id: 'mock-file' }); mocks.download.mockResolvedValue(Buffer.from(JSON.stringify(state)));
    expect(await getState()).toEqual(state); await saveState(state); await updateState(s => { s.settings.fitThreshold = 40; });
    expect(mocks.upload).toHaveBeenCalledTimes(2); expect(mocks.pool).not.toHaveBeenCalled(); expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
