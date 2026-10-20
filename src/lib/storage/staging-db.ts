import 'server-only';
import { createHash } from 'node:crypto';
import { createPool } from 'mysql2/promise';
import { createStagingState } from '../staging-state';
import { stagingDatabaseOptions, StagingDatabaseError } from './staging-db-config';
import { migrations, migrationTable } from './staging-db-migrations';
import { MysqlState, encodeState } from './mysql-state';

export class StagingDatabase extends MysqlState {
  protected initialize() { return this.migrate(); }
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
        await sql('INSERT INTO rolebright_state (id, format_version, revision, document) VALUES (1, 1, 0, ?) ON DUPLICATE KEY UPDATE id = id', [encodeState(createStagingState())]);
      } finally {
        const released = await sql('SELECT RELEASE_LOCK(?) AS released', [lock]) as { released: number }[];
        if (released[0]?.released !== 1) throw new StagingDatabaseError('Staging migration lock release failed.');
      }
    });
  }

}
let instance: StagingDatabase | undefined;
export function stagingDatabase(): StagingDatabase {
  const options = stagingDatabaseOptions(); // Validate before client initialization, including every call.
  try { return instance ??= new StagingDatabase(createPool(options), options.database!); }
  catch { throw new StagingDatabaseError(); }
}
