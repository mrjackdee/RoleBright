import 'server-only';
import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import type { AppState } from '../types';
import { DatabaseError } from './database-error';

export type Sql = (sql: string, values?: (string | number)[]) => Promise<unknown>;
type DocumentRow = { document: string; revision: string; format_version: number };
const deadlineMs = 20000;
export function parseState(row?: DocumentRow): AppState {
  if (!row || row.format_version !== 1) throw new DatabaseError('Unsupported or missing database state document.');
  const state = JSON.parse(row.document) as AppState;
  if (!state || typeof state !== 'object' || state.schemaVersion !== 1 || !Array.isArray(state.jobs) || !Array.isArray(state.analyses) || !Array.isArray(state.applications) || !Array.isArray(state.applicationPackages) || !Array.isArray(state.masterResumes) || !Array.isArray(state.searchRuns) || !state.settings) throw new DatabaseError('Invalid database state document.');
  return state; // Preserve ALL JSON properties, including unknown forward-compatible fields.
}
export function encodeState(state: AppState): string {
  const document = JSON.stringify(state);
  if (Buffer.byteLength(document, 'utf8') > 8 * 1024 * 1024) throw new DatabaseError('Database state exceeds the 8 MiB document limit.');
  parseState({ document, revision: '0', format_version: 1 });
  return document;
}
export abstract class MysqlState {
  private ready?: Promise<void>;
  private readonly revisions = new WeakMap<AppState, string>();
  constructor(private readonly pool: Pool, protected readonly database: string) {}
  protected async connection<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
    let connection: PoolConnection | undefined;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = (async () => {
      connection = await this.pool.getConnection();
      if (finished) { connection.destroy(); throw new DatabaseError(); }
      const sql: Sql = async (statement, values = []) => {
        if (finished) throw new DatabaseError();
        const [result] = await connection!.execute(statement, values);
        return result;
      };
      return work(sql);
    })();
    try {
      return await Promise.race([task, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { finished = true; connection?.destroy(); reject(new DatabaseError('Database operation timed out; outcome may be unknown. Do not automatically retry.')); }, deadlineMs);
      })]);
    } catch (error) {
      // Destroy on every failure: rollback and release named locks even if cleanup failed.
      if (!finished) connection?.destroy();
      finished = true;
      if (error instanceof DatabaseError) throw error;
      // Never expose driver messages containing connection details, SQL or state values.
      throw new DatabaseError();
    } finally {
      if (timer) clearTimeout(timer);
      if (!finished) connection?.release();
      finished = true;
    }
  }
  protected abstract initialize(): Promise<void>;
  protected async initializationUsable(): Promise<boolean> {
    // Observe an existing attempt, including one still in flight, without starting
    // or retrying initialization. A rejected promise remains rejected until restart.
    try { await this.ready; return true; } catch { return false; }
  }
  private ensureReady() {
    // Failed initialization stays failed for this instance. Never replay uncertain effects.
    return this.ready ??= this.initialize();
  }
  async read(): Promise<AppState> {
    await this.ensureReady();
    return this.connection(async sql => {
      const row = (await sql('SELECT document, revision, format_version FROM rolebright_state WHERE id = 1') as DocumentRow[])[0];
      const state = parseState(row);
      this.revisions.set(state, String(row.revision));
      return state;
    });
  }
  async update<T>(mutate: (state: AppState) => T | Promise<T>): Promise<T> {
    await this.ensureReady();
    return this.connection(async sql => {
      await sql('SET SESSION innodb_lock_wait_timeout = 5');
      await sql('START TRANSACTION');
      let committing = false;
      try {
        const state = parseState((await sql('SELECT document, revision, format_version FROM rolebright_state WHERE id = 1 FOR UPDATE') as DocumentRow[])[0]);
        const result = await mutate(state); // Exactly once; never retry arbitrary callbacks.
        state.updatedAt = new Date().toISOString();
        await sql('UPDATE rolebright_state SET document = ?, revision = revision + 1 WHERE id = 1', [encodeState(state)]);
        committing = true;
        await sql('COMMIT');
        return result;
      } catch (error) {
        await sql('ROLLBACK').catch(() => undefined);
        if (committing) throw new DatabaseError('Database commit outcome unknown. Reload state before any manual retry.');
        throw error;
      }
    });
  }
  async save(state: AppState): Promise<void> {
    const revision = this.revisions.get(state);
    if (revision === undefined) throw new DatabaseError('saveState requires the original snapshot from getState; use updateState for changes.');
    await this.ensureReady();
    await this.connection(async sql => {
      state.updatedAt = new Date().toISOString();
      const result = await sql('UPDATE rolebright_state SET document = ?, revision = revision + 1 WHERE id = 1 AND revision = ?', [encodeState(state), revision]) as ResultSetHeader;
      if (result.affectedRows !== 1) throw new DatabaseError('Database state changed; reload before saving.');
      this.revisions.set(state, (BigInt(revision) + BigInt(1)).toString());
    });
  }
  async close() { await this.pool.end(); }
}
