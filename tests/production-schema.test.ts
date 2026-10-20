// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ pool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ createPool: mocks.pool }));
import { productionSchemaOptions, setupProductionSchema } from '@/lib/storage/production-schema-setup';
import { productionTarget } from '@/lib/storage/production-db-config';
import { fakeEngine } from './fixtures/fake-db';

const env = {
  APP_ENV: 'production', PROD_SCHEMA_SETUP: 'create-empty-schema', PROD_DB_HOST: 'db.example.invalid',
  PROD_DB_NAME: productionTarget.database, PROD_DB_TLS: 'required',
  PROD_MIGRATION_USER: 'synthetic_schema_operator', PROD_MIGRATION_PASSWORD: 'synthetic-only',
};
beforeEach(() => vi.clearAllMocks());
describe('explicit schema setup, mocked SQL only', () => {
  it('importing the module does not construct clients', () => { expect(mocks.pool).not.toHaveBeenCalled(); });
  it.each([{ PROD_SCHEMA_SETUP: '' }, { APP_ENV: 'staging' }, { PROD_MIGRATION_USER: productionTarget.user },
    { PROD_MIGRATION_USER: 'rb_stageuser' }, { PROD_MIGRATION_PASSWORD: '' }, { PROD_DB_NAME: 'other_db' }])(
    'denies incomplete privileged setup before client construction: %j', async change => {
      await expect(setupProductionSchema({ ...env, ...change })).rejects.toThrow();
      expect(mocks.pool).not.toHaveBeenCalled();
    });
  it('uses separate credentials without activating application storage', () => {
    expect(productionSchemaOptions(env)).toMatchObject({ user: env.PROD_MIGRATION_USER, password: 'synthetic-only', connectionLimit: 1 });
    expect(env).not.toHaveProperty('PRODUCTION_STORAGE');
  });
  it('creates schema repeatably with no state insert, closes connections, and fails on unknown migrations', async () => {
    const engine = fakeEngine(); const pool = engine.pool(); mocks.pool.mockReturnValue(pool);
    await setupProductionSchema(env); await setupProductionSchema(env);
    expect(engine.applied).toHaveLength(1);
    expect(engine.calls.some(sql => sql.startsWith('INSERT INTO rolebright_state'))).toBe(false);
    expect(pool.end).toHaveBeenCalledTimes(2);
    engine.applied.push({ version: 99, checksum: 'unknown' });
    await expect(setupProductionSchema(env)).rejects.toThrow('migration');
    expect(pool.end).toHaveBeenCalledTimes(3);
  });
});
