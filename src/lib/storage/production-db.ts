import 'server-only';
import { createPool } from 'mysql2/promise';
import { DatabaseError } from './database-error';
import { MysqlState, parseState, type Sql } from './mysql-state';
import { migrations } from './staging-db-migrations';
import { productionDatabaseOptions } from './production-db-config';
import { checkProductionTable } from './production-schema-contract';

export async function checkProductionTarget(sql: Sql, database: string): Promise<boolean> {
  const identity = await sql('SELECT DATABASE() AS database_name, VERSION() AS version') as { database_name: string; version: string }[];
  if (identity[0]?.database_name !== database) throw new DatabaseError('Unexpected database target.');
  const version = identity[0].version;
  const match = version.replace(/^5\.5\.5-/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  const major = Number(match?.[1]), minor = Number(match?.[2]), patch = Number(match?.[3]);
  const supported = /MariaDB/i.test(version)
    ? major > 10 || (major === 10 && minor >= 6)
    : major > 8 || (major === 8 && (minor > 0 || patch >= 16));
  if (!match || !supported) throw new DatabaseError('Unsupported database engine.');
  return /MariaDB/i.test(version);
}

export async function checkProductionSchema(sql: Sql, database: string): Promise<void> {
  const maria = await checkProductionTarget(sql, database);
  await checkProductionTable(sql, database, 'rolebright_migrations', maria);
  await checkProductionTable(sql, database, 'rolebright_state', maria);
  const applied = await sql('SELECT version, checksum FROM rolebright_migrations ORDER BY version') as { version: number; checksum: string }[];
  if (applied.length !== migrations.length || migrations.some(m => !applied.some(row => row.version === m.version && row.checksum === m.checksum))) {
    throw new DatabaseError('Missing or incompatible production schema.');
  }
}

export class ProductionDatabase extends MysqlState {
  protected async initialize(): Promise<void> {
    await this.connection(sql => checkProductionSchema(sql, this.database));
  }
  // Operator-only module API, deliberately not an HTTP route. No getState/migrate/seed.
  // Rechecks the database only while this adapter's initialization remains usable.
  async readiness(): Promise<{ ready: boolean }> {
    if (!await this.initializationUsable()) return { ready: false };
    try {
      await this.connection(async sql => {
        await checkProductionSchema(sql, this.database);
        const rows = await sql('SELECT document, revision, format_version FROM rolebright_state WHERE id = 1') as Parameters<typeof parseState>[0][];
        parseState(rows[0]);
      });
      // An application initialization may have failed while the probe was running.
      return { ready: await this.initializationUsable() };
    } catch { return { ready: false }; }
  }
}

let instance: ProductionDatabase | undefined;
export function productionDatabase(): ProductionDatabase {
  const options = productionDatabaseOptions();
  try { return instance ??= new ProductionDatabase(createPool(options), options.database!); }
  catch { throw new DatabaseError(); }
}
