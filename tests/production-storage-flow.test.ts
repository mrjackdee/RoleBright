// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const clients = vi.hoisted(() => ({ pool: vi.fn(), file: vi.fn(), drive: vi.fn() }));
vi.mock('mysql2/promise', () => ({ createPool: clients.pool }));
vi.mock('node:fs/promises', () => ({ default: { readFile: clients.file, writeFile: clients.file, mkdir: clients.file } }));
vi.mock('@/lib/storage/google', () => ({
  googleConfigured: () => true, findFileByName: clients.drive, downloadFile: clients.drive, uploadBuffer: clients.drive,
}));
import { fakeEngine } from './fixtures/fake-db';
import { createStagingState } from '@/lib/staging-state';
import { migrations } from '@/lib/storage/staging-db-migrations';

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  for (const [key, value] of Object.entries({
    APP_ENV: 'production', PRODUCTION_STORAGE: 'mysql', PROD_DB_HOST: 'db.example.invalid',
    PROD_DB_NAME: 'u761630263_rb_prod', PROD_DB_USER: 'u761630263_rb_prodapp', PROD_DB_PASSWORD: 'synthetic-only',
    PROD_DB_TLS: 'required', USE_LOCAL_STATE: 'true',
  })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

describe('actual state facade with synthetic production adapter', () => {
  it('routes reads/tracking-style updates/saves through MySQL without DDL or legacy clients', async () => {
    const engine = fakeEngine(); engine.applied.push(...migrations); engine.seed(createStagingState());
    clients.pool.mockReturnValue(engine.pool());
    const { getState, updateState, saveState } = await import('@/lib/storage/state');
    const initial = await getState();
    const id = initial.applications[0].id;
    await updateState(state => { state.applications.find(a => a.id === id)!.notes.push('synthetic tracking change'); });
    const current = await getState();
    expect(current.applications[0].notes.at(-1)).toBe('synthetic tracking change');
    current.settings.fitThreshold = 35; await saveState(current);
    expect((await getState()).settings.fitThreshold).toBe(35);
    expect(engine.calls.some(sql => /^(CREATE|INSERT|DROP|DELETE)/.test(sql))).toBe(false);
    expect(clients.file).not.toHaveBeenCalled(); expect(clients.drive).not.toHaveBeenCalled();
  });
  it('denies corrupt stored state before mutation and never recovers from legacy data', async () => {
    const engine = fakeEngine(); engine.applied.push(...migrations); engine.corrupt(); clients.pool.mockReturnValue(engine.pool());
    const { getState, updateState } = await import('@/lib/storage/state');
    const mutate = vi.fn();
    await expect(getState()).rejects.toThrow('unavailable'); await expect(updateState(mutate)).rejects.toThrow('unavailable');
    expect(mutate).not.toHaveBeenCalled(); expect(clients.file).not.toHaveBeenCalled(); expect(clients.drive).not.toHaveBeenCalled();
  });
});
