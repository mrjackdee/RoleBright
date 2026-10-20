import 'server-only';
import { createHash } from 'node:crypto';
import { createPool } from 'mysql2/promise';
import { DatabaseError } from './database-error';
import { MysqlState } from './mysql-state';
import { productionDatabaseOptions, productionTarget } from './production-db-config';
import { checkProductionSchema, checkProductionTarget } from './production-db';
import { migrations, migrationTable } from './staging-db-migrations';
import { checkProductionTable } from './production-schema-contract';

// Operator entry point only. No application module imports this file.
// Explicit invocation applies DDL; its flag is not user approval or a grant.
export function productionSchemaOptions(env: Record<string, string | undefined>) {
  const user = env.PROD_MIGRATION_USER;
  if (env.APP_ENV !== 'production' || env.PROD_SCHEMA_SETUP !== 'create-empty-schema' ||
      !user || !/^[a-zA-Z0-9_]+$/.test(user) || /stag/i.test(user) ||
      user === productionTarget.user || !env.PROD_MIGRATION_PASSWORD) {
    throw new DatabaseError('Separate approved schema setup configuration is required.');
  }
  const options = productionDatabaseOptions({
    ...env, PRODUCTION_STORAGE: 'mysql', PROD_DB_USER: productionTarget.user,
    PROD_DB_PASSWORD: env.PROD_MIGRATION_PASSWORD,
  });
  return { ...options, user, connectionLimit: 1, maxIdle: 1 };
}

class SchemaSetup extends MysqlState {
  protected async initialize(): Promise<void> { throw new DatabaseError('Schema setup is not application storage.'); }
  async apply(): Promise<void> {
    await this.connection(async sql => {
      const maria = await checkProductionTarget(sql, this.database);
      const name = 'rolebright:' + createHash('sha256').update(this.database).digest('hex').slice(0, 40);
      const lock = await sql('SELECT GET_LOCK(?, 5) AS acquired', [name]) as { acquired: number }[];
      if (lock[0]?.acquired !== 1) throw new DatabaseError('Schema lock unavailable.');
      try {
        await sql(migrationTable);
        await checkProductionTable(sql, this.database, 'rolebright_migrations', maria);
        const applied = await sql('SELECT version, checksum FROM rolebright_migrations ORDER BY version') as { version: number; checksum: string }[];
        for (const row of applied) {
          if (!migrations.some(m => m.version === row.version && m.checksum === row.checksum)) throw new DatabaseError('Unknown or changed schema migration.');
        }
        for (const migration of migrations) {
          if (applied.some(row => row.version === migration.version)) continue;
          await sql(migration.sql);
          // IF NOT EXISTS may have found an unrelated table. Do not certify it
          // (or interrupted DDL) until its actual columns/keys/checks match v1.
          await checkProductionTable(sql, this.database, 'rolebright_state', maria);
          await sql('INSERT INTO rolebright_migrations (version, checksum) VALUES (?, ?)', [migration.version, migration.checksum]);
        }
        await checkProductionSchema(sql, this.database);
        // Intentionally no state row: initial data/cutover is a separate reviewed operation.
      } finally {
        const released = await sql('SELECT RELEASE_LOCK(?) AS released', [name]) as { released: number }[];
        if (released[0]?.released !== 1) throw new DatabaseError('Schema lock release failed.');
      }
    });
  }
}

export async function setupProductionSchema(env: Record<string, string | undefined>): Promise<void> {
  const options = productionSchemaOptions(env); // Validation before pool construction.
  let setup: SchemaSetup | undefined;
  try {
    setup = new SchemaSetup(createPool(options), options.database!);
    await setup.apply();
  } catch (error) {
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError();
  } finally {
    // Close failures are sanitized too; never replay an uncertain DDL operation.
    if (setup) { try { await setup.close(); } catch { throw new DatabaseError(); } }
  }
}
