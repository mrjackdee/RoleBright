// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { ProductionDatabase } from '@/lib/storage/production-db';
import { productionTarget, productionDatabaseOptions, productionStorageSelected } from '@/lib/storage/production-db-config';
import { migrations } from '@/lib/storage/staging-db-migrations';
import { createStagingState } from '@/lib/staging-state';
import { fakeEngine } from './fixtures/fake-db';

export const productionEnv = {
  APP_ENV: 'production', PRODUCTION_STORAGE: 'mysql', PROD_DB_HOST: 'db.example.invalid',
  PROD_DB_NAME: productionTarget.database, PROD_DB_USER: productionTarget.user,
  PROD_DB_PASSWORD: 'synthetic-only', PROD_DB_TLS: 'required',
};
function fixture() {
  const engine = fakeEngine();
  engine.applied.push(...migrations.map(({ version, checksum }) => ({ version, checksum })));
  engine.seed(createStagingState()); // Test injection only; runtime never seeds.
  return { engine, db: new ProductionDatabase(engine.pool(), productionTarget.database) };
}
afterEach(() => vi.useRealTimers());

describe('production configuration (synthetic only)', () => {
  it('uses isolated settings and bounded verified TLS', () => {
    expect(productionDatabaseOptions({ ...productionEnv, DB_HOST: 'ignored.invalid', DATABASE_URL: 'ignored' }))
      .toMatchObject({ host: 'db.example.invalid', connectionLimit: 4, waitForConnections: false, multipleStatements: false,
        ssl: { rejectUnauthorized: true, verifyIdentity: true } });
    expect(productionStorageSelected({ APP_ENV: 'production' })).toBe(false);
  });
  it.each([
    { APP_ENV: 'staging' }, { APP_ENV: '' }, { PRODUCTION_STORAGE: 'local' }, { PRODUCTION_STORAGE: '' },
    { PROD_DB_HOST: '127.0.0.1' }, { PROD_DB_HOST: '::1' }, { PROD_DB_HOST: '' },
    { PROD_DB_NAME: 'u761630263_rb_staging' }, { PROD_DB_USER: 'u761630263_rb_stageuser' },
    { PROD_DB_PASSWORD: '' }, { PROD_DB_TLS: 'false' }, { PROD_DB_PORT: '-1' },
  ])('rejects invalid inputs without leaking secrets: %j', change => {
    expect(() => productionDatabaseOptions({ ...productionEnv, ...change })).toThrow();
    try { productionDatabaseOptions({ ...productionEnv, ...change }); } catch (error) { expect(String(error)).not.toContain('synthetic-only'); }
  });
});

describe('production adapter protocol model, not live database acceptance', () => {
  it('waits for an in-flight initialization failure without retrying or reporting ready', async () => {
    const { engine } = fixture(); const pool = engine.pool();
    let reject!: (error: Error) => void;
    const acquire = vi.spyOn(pool, 'getConnection').mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const db = new ProductionDatabase(pool, productionTarget.database);
    const read = expect(db.read()).rejects.toThrow('unavailable');
    const ready = db.readiness();
    reject(new Error('transient synthetic failure'));
    await read;
    expect(await ready).toEqual({ ready: false });
    expect(await db.readiness()).toEqual({ ready: false });
    await expect(db.update(vi.fn())).rejects.toThrow('unavailable');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(engine.calls).toEqual([]);
  });
  it('reads and checks readiness using only SELECT, preserving unknown fields', async () => {
    const { db, engine } = fixture();
    expect(await db.readiness()).toEqual({ ready: true });
    const state = await db.read(); Object.assign(state, { future: { preserved: true } });
    expect(engine.calls.every(sql => sql.startsWith('SELECT'))).toBe(true);
    await db.save(state);
    expect(await db.read()).toEqual(state);
  });
  it('does not create or seed missing schema/state, and rechecks readiness', async () => {
    const engine = fakeEngine(); const db = new ProductionDatabase(engine.pool(), productionTarget.database);
    expect(await db.readiness()).toEqual({ ready: false });
    await expect(db.read()).rejects.toThrow('schema');
    engine.applied.push(...migrations);
    expect(await db.readiness()).toEqual({ ready: false });
    engine.seed(createStagingState());
    expect(await db.readiness()).toEqual({ ready: false });
    const restarted = new ProductionDatabase(engine.pool(), productionTarget.database);
    expect(await restarted.readiness()).toEqual({ ready: true });
    await expect(restarted.read()).resolves.toBeTruthy();
    expect(engine.calls.every(sql => sql.startsWith('SELECT'))).toBe(true);
    // A failed application initialization stays failed until a new instance/process.
    await expect(db.read()).rejects.toThrow('schema');
  });
  it('rejects wrong database, engine, checksum and corrupt data', async () => {
    const { db, engine } = fixture();
    await expect(new ProductionDatabase(engine.pool(), 'wrong_target').read()).rejects.toThrow('target');
    engine.version('5.7.44'); expect(await db.readiness()).toEqual({ ready: false });
    engine.version('8.0.36'); engine.applied[0].checksum = 'changed';
    expect(await db.readiness()).toEqual({ ready: false });
    engine.applied[0].checksum = migrations[0].checksum; engine.corrupt();
    expect(await db.readiness()).toEqual({ ready: false });
    await expect(db.read()).rejects.toThrow('unavailable');
    expect(engine.calls.every(sql => sql.startsWith('SELECT'))).toBe(true);
  });
  it('serializes competing pools, preserves restart reads and rejects stale/copy saves', async () => {
    const { db, engine } = fixture(); const other = new ProductionDatabase(engine.pool(), productionTarget.database);
    const stale = await db.read();
    await expect(other.save(stale)).rejects.toThrow('original snapshot');
    const mutate = vi.fn(s => { s.applications[0].notes.push('synthetic edit'); });
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? db : other).update(mutate)));
    expect(mutate).toHaveBeenCalledTimes(20);
    const restarted = new ProductionDatabase(engine.pool(), productionTarget.database);
    expect((await restarted.read()).applications[0].notes.filter(n => n === 'synthetic edit')).toHaveLength(20);
    await expect(db.save(stale)).rejects.toThrow('changed');
    await expect(db.save(structuredClone(await db.read()))).rejects.toThrow('original snapshot');
  });
  it('rolls back failures and never retries an uncertain commit', async () => {
    const { db, engine } = fixture(); const before = await db.read();
    await expect(db.update(s => { s.jobs = []; throw new Error('private detail'); })).rejects.toThrow('unavailable');
    expect(await db.read()).toEqual(before);
    engine.fail('UPDATE rolebright_state SET document = ?, revision = revision + 1 WHERE id = 1', true);
    await expect(db.update(s => { s.jobs = []; })).rejects.toThrow('unavailable');
    expect(await db.read()).toEqual(before);
    engine.fail('COMMIT'); const mutate = vi.fn();
    await expect(db.update(mutate)).rejects.toThrow('outcome unknown');
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(engine.connections.filter(c => c.destroyed)).toHaveLength(3);
  });
  it('expires late mutations without writing', async () => {
    vi.useFakeTimers(); const { db, engine } = fixture(); await db.read();
    let finish!: () => void;
    const pending = db.update(async s => { s.jobs = []; await new Promise<void>(r => { finish = r; }); });
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20001); await rejected; finish(); await Promise.resolve();
    expect(engine.connections.at(-1)?.destroyed).toBe(true);
    expect((await db.read()).jobs).toHaveLength(2);
  });
});
