import 'server-only';
import { createHash } from 'node:crypto';
import { createPool, type Pool, type PoolConnection, type ResultSetHeader } from 'mysql2/promise';
import { createStagingState } from '../staging-state';
import type { AppState } from '../types';
import { stagingDatabaseOptions, StagingDatabaseError } from './staging-db-config';
import { migrations, migrationTable } from './staging-db-migrations';

type Sql = (sql: string, values?: (string | number)[]) => Promise<unknown>;
type DocumentRow = { document: string; revision: string; format_version: number };
const revisions = new WeakMap<AppState, string>();
const deadlineMs = 20000;
function parse(row?: DocumentRow): AppState {
  if (!row || row.format_version !== 1) throw new StagingDatabaseError('Unsupported or missing staging state document.');
  const state = JSON.parse(row.document) as AppState;
  if (!state || typeof state !== 'object' || state.schemaVersion !== 1 || !Array.isArray(state.jobs) || !Array.isArray(state.analyses) || !Array.isArray(state.applications) || !Array.isArray(state.applicationPackages) || !Array.isArray(state.masterResumes) || !Array.isArray(state.searchRuns) || !state.settings) throw new StagingDatabaseError('Invalid staging state document.');
  revisions.set(state, String(row.revision));
  return state; // Preserve ALL JSON properties, including unknown forward-compatible fields.
}
function encode(state: AppState): string {
  const document = JSON.stringify(state);
  if (Buffer.byteLength(document, 'utf8') > 8 * 1024 * 1024) throw new StagingDatabaseError('Staging state exceeds the 8 MiB document limit.');
  parse({ document, revision: '0', format_version: 1 });
  return document;
}
export class StagingDatabase {
  private ready?: Promise<void>;
  constructor(private readonly pool: Pool, private readonly database: string) {}
  private async connection<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
    let connection: PoolConnection | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = (async () => {
      connection = await this.pool.getConnection();
      if (finished) { connection.destroy(); throw new StagingDatabaseError(); }
      const sql: Sql = async (statement, values = []) => {
        if (finished) throw new StagingDatabaseError();
        const [result] = await connection!.execute(statement, values);
        return result;
      };
      return work(sql);
    })();
    try {
      return await Promise.race([task, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { finished = true; connection?.destroy(); reject(new StagingDatabaseError('Staging database operation timed out; outcome may be unknown. Do not automatically retry.')); }, deadlineMs);
      })]);
    } catch (error) {
      // Destroy on every failure: rollback and release named locks even if cleanup failed.
      if (!finished) connection?.destroy();
      finished = true;
      if (error instanceof StagingDatabaseError) throw error;
      // Never expose driver messages containing connection details, SQL or state values.
      throw new StagingDatabaseError();
    } finally {
      if (timer) clearTimeout(timer);
      if (!finished) connection?.release();
      finished = true;
    }
  }
  async migrate(): Promise<void> {
    return this.connection(async sql => {
      const lock = 'rolebright:' + createHash('sha256').update(this.database).digest('hex').slice(0, 40);
      const acquired = await sql('SELECT GET_LOCK(?, 5) AS acquired', [lock]) as { acquired: number }[];
      if (acquired[0]?.acquired !== 1) throw new StagingDatabaseError('Staging migration lock unavailable.');
      try {
        const versions = await sql('SELECT VERSION() AS version') as { version: string }[];
        const version = versions[0]?.version ?? '';
        const match = version.replace(/^5\.5\.5-/, '').match(/(\d+)\.(\d+)\.(\d+)/);
        const major = Number(match?.[1]), minor = Number(match?.[2]), patch = Number(match?.[3]);
        const supported = /MariaDB/i.test(version) ? major > 10 || (major === 10 && minor >= 6) : major > 8 || (major === 8 && (minor > 0 || patch >= 16));
        if (!match || !supported) throw new StagingDatabaseError('Requires MySQL 8.0.16+ or MariaDB 10.6+ with InnoDB.');
        await sql(migrationTable);
        const applied = await sql('SELECT version, checksum FROM rolebright_migrations ORDER BY version') as { version: number; checksum: string }[];
        for (const row of applied) if (!migrations.some(m => m.version === row.version && m.checksum === row.checksum)) throw new StagingDatabaseError('Unknown or changed database migration; manual review required.');
        for (const migration of migrations) {
          if (applied.some(row => row.version === migration.version)) continue;
          await sql(migration.sql);
          await sql('INSERT INTO rolebright_migrations (version, checksum) VALUES (?, ?)', [migration.version, migration.checksum]);
        }
        const engines = await sql('SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?)', [this.database, 'rolebright_state', 'rolebright_migrations']) as { engine: string }[];
        if (engines.length !== 2 || engines.some(row => row.engine !== 'InnoDB')) throw new StagingDatabaseError('Staging tables must use InnoDB.');
        await sql('INSERT INTO rolebright_state (id, format_version, revision, document) VALUES (1, 1, 0, ?) ON DUPLICATE KEY UPDATE id = id', [encode(createStagingState())]);
      } finally {
        const released = await sql('SELECT RELEASE_LOCK(?) AS released', [lock]) as { released: number }[];
        if (released[0]?.released !== 1) throw new StagingDatabaseError('Staging migration lock release failed.');
      }
    });
  }
  private ensureReady() {
    // A failed migration stays failed for this process. No automatic replay after uncertain results.
    return this.ready ??= this.migrate();
  }
  async read(): Promise<AppState> {
    await this.ensureReady();
    return this.connection(async sql => parse((await sql('SELECT document, revision, format_version FROM rolebright_state WHERE id = 1') as DocumentRow[])[0]));
  }
  async update<T>(mutate: (state: AppState) => T | Promise<T>): Promise<T> {
    await this.ensureReady();
    return this.connection(async sql => {
      await sql('SET SESSION innodb_lock_wait_timeout = 5');
      await sql('START TRANSACTION');
      let committing = false;
      try {
        const state = parse((await sql('SELECT document, revision, format_version FROM rolebright_state WHERE id = 1 FOR UPDATE') as DocumentRow[])[0]);
        const result = await mutate(state); // Exactly once; never retry arbitrary callbacks.
        state.updatedAt = new Date().toISOString();
        await sql('UPDATE rolebright_state SET document = ?, revision = revision + 1 WHERE id = 1', [encode(state)]);
        committing = true;
        await sql('COMMIT');
        return result;
      } catch (error) {
        await sql('ROLLBACK').catch(() => undefined);
        if (committing) throw new StagingDatabaseError('Staging commit outcome unknown. Reload state before any manual retry.');
        throw error;
      }
    });
  }
  async save(state: AppState): Promise<void> {
    const revision = revisions.get(state);
    if (revision === undefined) throw new StagingDatabaseError('saveState requires the original snapshot from getState; use updateState for changes.');
    await this.ensureReady();
    await this.connection(async sql => {
      state.updatedAt = new Date().toISOString();
      const result = await sql('UPDATE rolebright_state SET document = ?, revision = revision + 1 WHERE id = 1 AND revision = ?', [encode(state), revision]) as ResultSetHeader;
      if (result.affectedRows !== 1) throw new StagingDatabaseError('Staging state changed; reload before saving.');
      revisions.set(state, (BigInt(revision) + BigInt(1)).toString());
    });
  }
  async close() { await this.pool.end(); }
}
let instance: StagingDatabase | undefined;
export function stagingDatabase(): StagingDatabase {
  const options = stagingDatabaseOptions(); // Validate before client initialization, including every call.
  try { return instance ??= new StagingDatabase(createPool(options), options.database!); }
  catch { throw new StagingDatabaseError(); }
}
