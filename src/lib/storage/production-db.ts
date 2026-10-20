import 'server-only';
import { createPool } from 'mysql2/promise';
import { DatabaseError } from './database-error';
import { MysqlState, parseState, type Sql } from './mysql-state';
import { migrations } from './staging-db-migrations';
import { productionDatabaseOptions } from './production-db-config';

export async function checkProductionTarget(sql: Sql, database: string): Promise<void> {
  const identity = await sql('SELECT DATABASE() AS database_name, VERSION() AS version') as { database_name: string; version: string }[];
  if (identity[0]?.database_name !== database) throw new DatabaseError('Unexpected database target.');
  const version = identity[0].version;
  const match = version.replace(/^5\.5\.5-/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  const major = Number(match?.[1]), minor = Number(match?.[2]), patch = Number(match?.[3]);
  const supported = /MariaDB/i.test(version)
    ? major > 10 || (major === 10 && minor >= 6)
    : major > 8 || (major === 8 && (minor > 0 || patch >= 16));
  if (!match || !supported) throw new DatabaseError('Unsupported database engine.');
}

export async function checkProductionSchema(sql: Sql, database: string): Promise<void> {
  await checkProductionTarget(sql, database);
  const applied = await sql('SELECT version, checksum FROM rolebright_migrations ORDER BY version') as { version: number; checksum: string }[];
  if (applied.length !== migrations.length || migrations.some(m => !applied.some(row => row.version === m.version && row.checksum === m.checksum))) {
    throw new DatabaseError('Missing or incompatible production schema.');
  }
  const engines = await sql('SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?)', [database, 'rolebright_state', 'rolebright_migrations']) as { engine: string }[];
  if (engines.length !== 2 || engines.some(row => row.engine !== 'InnoDB')) throw new DatabaseError('Production tables must use InnoDB.');
}

export class ProductionDatabase extends MysqlState {
  protected async initialize(): Promise<void> {
    await this.connection(sql => checkProductionSchema(sql, this.database));
  }
  // Operator-only module API, deliberately not an HTTP route. No getState/migrate/seed.
  // Rechecks on every invocation instead of using cached initialization.
  async readiness(): Promise<{ ready: boolean }> {
    try {
      await this.connection(async sql => {
        await checkProductionSchema(sql, this.database);
        const rows = await sql('SELECT document, revision, format_version FROM rolebright_state WHERE id = 1') as Parameters<typeof parseState>[0][];
        parseState(rows[0]);
      });
      return { ready: true };
    } catch { return { ready: false }; }
  }
}

let instance: ProductionDatabase | undefined;
export function productionDatabase(): ProductionDatabase {
  const options = productionDatabaseOptions();
  try { return instance ??= new ProductionDatabase(createPool(options), options.database!); }
  catch { throw new DatabaseError(); }
}
