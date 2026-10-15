// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
vi.mock('server-only', () => ({}));
import { StagingDatabase } from '@/lib/storage/staging-db';
import { stagingDatabaseOptions } from '@/lib/storage/staging-db-config';
import { migrations } from '@/lib/storage/staging-db-migrations';

// Protocol/transaction model ONLY: this does not execute SQL or prove engine compatibility.
function fakeEngine() {
  let document: string | undefined; let revision = 0;
  const applied: { version: number; checksum: string }[] = [];
  const calls: string[] = [];
  let lock: Promise<void> = Promise.resolve(); let rowLock: Promise<void> = Promise.resolve();
  let fail = ''; let failOnce = false; let hang = ''; let version = '8.0.36';
  const connections: { released: boolean; destroyed: boolean }[] = [];
  const pool = () => ({
    end: vi.fn(async () => undefined),
    getConnection: vi.fn(async () => {
      const flags = { released: false, destroyed: false }; connections.push(flags);
      let unlock: (() => void) | undefined; let unlockRow: (() => void) | undefined; let pending: string | undefined;
      return {
        release: () => { flags.released = true; },
        destroy: () => { flags.destroyed = true; pending = undefined; unlock?.(); unlockRow?.(); },
        execute: async (sql: string, values: unknown[] = []) => {
          calls.push(sql);
          if (sql === hang) return new Promise(() => undefined);
          if (sql === fail) { if (failOnce) fail = ''; throw new Error('sensitive driver detail'); }
          if (sql.startsWith('SELECT GET_LOCK')) { const before = lock; lock = new Promise<void>(r => { unlock = r; }); await before; return [[{ acquired: 1 }]]; }
          if (sql.startsWith('SELECT RELEASE_LOCK')) { unlock?.(); unlock = undefined; return [[{ released: 1 }]]; }
          if (sql.startsWith('SELECT VERSION')) return [[{ version }]];
          if (sql.startsWith('CREATE TABLE')) return [{}];
          if (sql.startsWith('SELECT version, checksum')) return [structuredClone(applied)];
          if (sql.startsWith('INSERT INTO rolebright_migrations')) { applied.push({ version: Number(values[0]), checksum: String(values[1]) }); return [{}]; }
          if (sql.startsWith('SELECT ENGINE')) return [[{ engine: 'InnoDB' }, { engine: 'InnoDB' }]];
          if (sql.startsWith('INSERT INTO rolebright_state')) { document ??= String(values[0]); return [{}]; }
          if (sql.startsWith('SET SESSION') || sql === 'START TRANSACTION') return [{}];
          if (sql.startsWith('SELECT document')) {
            if (sql.endsWith('FOR UPDATE')) { const before = rowLock; rowLock = new Promise<void>(r => { unlockRow = r; }); await before; }
            return [[{ document, revision: String(revision), format_version: 1 }]];
          }
          if (sql.startsWith('UPDATE rolebright_state')) {
            if (values.length === 2 && String(values[1]) !== String(revision)) return [{ affectedRows: 0 }];
            if (unlockRow) pending = String(values[0]); else { document = String(values[0]); revision++; }
            return [{ affectedRows: 1 }];
          }
          if (sql === 'COMMIT') { if (pending) { document = pending; revision++; } pending = undefined; unlockRow?.(); unlockRow = undefined; return [{}]; }
          if (sql === 'ROLLBACK') { pending = undefined; unlockRow?.(); unlockRow = undefined; return [{}]; }
          throw new Error('Unexpected SQL: ' + sql);
        },
      };
    }),
  }) as unknown as Pool;
  return { pool, calls, applied, connections, fail: (sql: string, once = false) => { fail = sql; failOnce = once; }, hang: (sql: string) => { hang = sql; }, version: (v: string) => { version = v; } };
}
afterEach(() => vi.useRealTimers());
describe('staging MySQL adapter (mock protocol, not engine acceptance)', () => {
  it('serializes repeatable migration and seed across two pools, preserving edits after restart', async () => {
    const engine = fakeEngine(); const a = new StagingDatabase(engine.pool(), 'test_staging'); const b = new StagingDatabase(engine.pool(), 'test_staging');
    await Promise.all([a.migrate(), b.migrate()]);
    expect(engine.applied).toEqual(migrations.map(({ version, checksum }) => ({ version, checksum })));
    await a.update(s => { s.jobs[0].title = 'Edited fixture'; s.applications[0].notes.push('retained'); });
    await a.close(); const restarted = new StagingDatabase(engine.pool(), 'test_staging');
    const state = await restarted.read(); expect(state.jobs[0].title).toBe('Edited fixture'); expect(state.applications[0].notes).toContain('retained');
    expect(state.jobs.every(j => j.applicationUrl === '/guide' && j.sourceUrl === '/guide')).toBe(true);
    expect(engine.connections.every(c => c.released)).toBe(true);
  });
  it('roundtrips full state and unknown nested fields without normalization', async () => {
    const engine = fakeEngine(); const db = new StagingDatabase(engine.pool(), 'test_staging');
    const state = await db.read();
    Object.assign(state, { future: { nested: ['hello', 42, { unicode: 'Résumé 日本語' }] } });
    Object.assign(state.jobs[0], { futureJobField: { a: true } }); state.settings.fitThreshold = 27;
    await db.save(state);
    expect(await db.read()).toEqual(state);
    const stale = await db.read(); await db.update(s => { s.settings.fitThreshold = 28; });
    await expect(db.save(stale)).rejects.toThrow('changed');
    await expect(db.save(structuredClone(state))).rejects.toThrow('original snapshot');
  });
  it('serializes cross-pool updates without replaying callbacks', async () => {
    const engine = fakeEngine(); const a = new StagingDatabase(engine.pool(), 'test_staging'); const b = new StagingDatabase(engine.pool(), 'test_staging');
    const mutate = vi.fn(s => { s.applications[0].notes.push('one'); });
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).update(mutate)));
    expect((await a.read()).applications[0].notes.filter(n => n === 'one')).toHaveLength(20); expect(mutate).toHaveBeenCalledTimes(20);
  });
  it('rolls back callback and write failures, destroys failed connections and recovers on later independent request', async () => {
    const engine = fakeEngine(); const db = new StagingDatabase(engine.pool(), 'test_staging'); const before = await db.read();
    await expect(db.update(s => { s.jobs = []; throw new Error('failure'); })).rejects.toThrow('unavailable');
    expect(await db.read()).toEqual(before);
    engine.fail('UPDATE rolebright_state SET document = ?, revision = revision + 1 WHERE id = 1', true);
    await expect(db.update(s => { s.jobs = []; })).rejects.toThrow('unavailable');
    expect(await db.read()).toEqual(before); expect(engine.calls).toContain('ROLLBACK'); expect(engine.connections.filter(c => c.destroyed)).toHaveLength(2);
  });
  it('does not retry uncertain commits or disclose driver errors', async () => {
    const engine = fakeEngine(); const db = new StagingDatabase(engine.pool(), 'test_staging'); await db.read(); engine.fail('COMMIT');
    const mutate = vi.fn(); await expect(db.update(mutate)).rejects.toThrow('outcome unknown'); expect(mutate).toHaveBeenCalledTimes(1);
  });
  it('times out and destroys connection, preventing a late callback from writing', async () => {
    vi.useFakeTimers(); const engine = fakeEngine(); const db = new StagingDatabase(engine.pool(), 'test_staging'); await db.read();
    let finish!: () => void; const pending = db.update(async s => { s.jobs = []; await new Promise<void>(r => { finish = r; }); });
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20001); await rejected; finish(); await Promise.resolve();
    expect(engine.connections.at(-1)?.destroyed).toBe(true); expect((await db.read()).jobs).toHaveLength(2);
  });
  it('destroys a connection acquired after the deadline without executing SQL', async () => {
    vi.useFakeTimers(); let resolve!: (value: unknown) => void;
    const connection = { destroy: vi.fn(), release: vi.fn(), execute: vi.fn() };
    const pool = { getConnection: () => new Promise(r => { resolve = r; }) } as unknown as Pool;
    const pending = new StagingDatabase(pool, 'test_staging').read();
    const rejected = expect(pending).rejects.toThrow('timed out'); await vi.advanceTimersByTimeAsync(20001); await rejected;
    resolve(connection); await Promise.resolve(); await Promise.resolve();
    expect(connection.destroy).toHaveBeenCalledTimes(1); expect(connection.execute).not.toHaveBeenCalled();
  });
  it('destroys the connection if rollback itself fails, without replay', async () => {
    const engine = fakeEngine(); const db = new StagingDatabase(engine.pool(), 'test_staging'); await db.read(); engine.fail('ROLLBACK');
    const mutate = vi.fn(() => { throw new Error('mutator failed'); });
    await expect(db.update(mutate)).rejects.toThrow('unavailable');
    expect(mutate).toHaveBeenCalledTimes(1); expect(engine.connections.at(-1)?.destroyed).toBe(true);
  });
  it('fails closed on migration checksum mismatch and unknown future migration', async () => {
    for (const row of [{ version: 1, checksum: 'changed' }, { version: 99, checksum: 'unknown' }]) {
      const engine = fakeEngine(); engine.applied.push(row);
      await expect(new StagingDatabase(engine.pool(), 'test_staging').read()).rejects.toThrow('migration');
      expect(engine.calls.some(c => c.startsWith('INSERT INTO rolebright_state'))).toBe(false);
    }
  });
  it('replays idempotent DDL after failure before recording without reseeding data', async () => {
    const engine = fakeEngine(); engine.fail('INSERT INTO rolebright_migrations (version, checksum) VALUES (?, ?)', true);
    await expect(new StagingDatabase(engine.pool(), 'test_staging').read()).rejects.toThrow();
    expect((await new StagingDatabase(engine.pool(), 'test_staging').read()).jobs).toHaveLength(2);
    expect(engine.calls.filter(c => c === migrations[0].sql)).toHaveLength(2);
  });
  it.each(['8.0.16', '8.4.1', '10.6.17-MariaDB', '5.5.5-10.11.6-MariaDB'])('accepts declared engine version %s in the mock', async version => {
    const engine = fakeEngine(); engine.version(version); await expect(new StagingDatabase(engine.pool(), 'test_staging').read()).resolves.toBeTruthy();
  });
  it.each(['5.7.44', '8.0.15', '10.5.1-MariaDB'])('rejects unsupported engine %s', async version => {
    const engine = fakeEngine(); engine.version(version); await expect(new StagingDatabase(engine.pool(), 'test_staging').read()).rejects.toThrow('Requires');
  });
  it('bounds pooling, disables multi-statements and requires verified TLS', () => {
    const env = { APP_ENV: 'staging', STAGING_STORAGE: 'mysql', DB_HOST: 'db.example.invalid', DB_NAME: 'rolebright_staging', DB_USER: 'synthetic', DB_PASSWORD: 'fake', DB_TLS: 'required' };
    expect(stagingDatabaseOptions(env)).toMatchObject({ connectionLimit: 4, waitForConnections: false, multipleStatements: false, ssl: { rejectUnauthorized: true, verifyIdentity: true } });
    for (const change of [{ STAGING_STORAGE: '' }, { DB_NAME: 'production' }, { DB_PASSWORD: '' }, { DB_TLS: 'false' }, { DB_PORT: '-1' }, { APP_ENV: 'production' }]) expect(() => stagingDatabaseOptions({ ...env, ...change })).toThrow();
  });
});
