// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ pool: vi.fn() }));
vi.mock('mysql2/promise', () => ({ createPool: mocks.pool }));
import { setupProductionSchema } from '@/lib/storage/production-schema-setup';
import { ProductionDatabase } from '@/lib/storage/production-db';
import { productionTarget } from '@/lib/storage/production-db-config';
import { migrations } from '@/lib/storage/staging-db-migrations';
import { createStagingState } from '@/lib/staging-state';
import { fakeEngine } from './fixtures/fake-db';
import { schemaMetadata } from './fixtures/schema-metadata';

const env = {
  APP_ENV: 'production', PROD_SCHEMA_SETUP: 'create-empty-schema', PROD_DB_HOST: 'db.example.invalid',
  PROD_DB_NAME: productionTarget.database, PROD_DB_TLS: 'required',
  PROD_MIGRATION_USER: 'synthetic_schema_operator', PROD_MIGRATION_PASSWORD: 'synthetic-only',
};
const incompatible: [string, (m: ReturnType<typeof schemaMetadata>) => void][] = [
  ['non-InnoDB', m => { m.rolebright_state.tables[0].engine = 'MyISAM'; }],
  ['view', m => { m.rolebright_state.tables[0].table_type = 'VIEW'; }],
  ['missing column', m => { m.rolebright_state.columns.pop(); }],
  ['extra column', m => { m.rolebright_state.columns.push({ ...m.rolebright_state.columns[0], name: 'extra' }); }],
  ['nullable revision', m => { m.rolebright_state.columns[2].nullable = 'YES'; }],
  ['signed revision', m => { m.rolebright_state.columns[2].column_type = 'bigint'; }],
  ['narrow revision', m => { m.rolebright_state.columns[2].column_type = 'int unsigned'; }],
  ['text document', m => { m.rolebright_state.columns[3].column_type = 'text'; }],
  ['short capacity', m => { m.rolebright_state.columns[3].char_length = 65535; }],
  ['wrong charset', m => { m.rolebright_state.columns[3].charset = 'latin1'; }],
  ['wrong collation', m => { m.rolebright_state.columns[3].collation = 'utf8mb4_general_ci'; }],
  ['generated revision', m => { m.rolebright_state.columns[2].extra = 'STORED GENERATED'; }],
  ['missing primary key', m => { m.rolebright_state.keys = []; }],
  ['non-unique key', m => { m.rolebright_state.keys[0].non_unique = 1; }],
  ['wrong primary key', m => { m.rolebright_state.keys[0].column_name = 'revision'; }],
  ['composite primary key', m => { m.rolebright_state.keys.push({ ...m.rolebright_state.keys[0], column_name: 'revision', position: 2 }); }],
  ['missing singleton check', m => { m.rolebright_state.constraints.splice(1, 1); }],
  ['disabled check', m => { m.rolebright_state.constraints[1].enforced = 'NO'; }],
  ['weakened singleton check', m => { m.rolebright_state.constraints[1].clause = 'id >= 1'; }],
  ['wrong JSON check', m => { m.rolebright_state.constraints[2].clause = 'document IS NOT NULL'; }],
  ['unexpected foreign key', m => { m.rolebright_state.constraints.push({ kind: 'FOREIGN KEY', clause: null, enforced: 'YES' }); }],
  ['short checksum', m => { m.rolebright_migrations.columns[1].column_type = 'char(16)'; }],
  ['wrong ledger primary key', m => { m.rolebright_migrations.keys[0].column_name = 'checksum'; }],
  ['missing timestamp default', m => { m.rolebright_migrations.columns[2].default_value = null; }],
  ['automatic timestamp mutation', m => { m.rolebright_migrations.columns[2].extra = 'on update CURRENT_TIMESTAMP'; }],
];
beforeEach(() => vi.clearAllMocks());

describe('production schema adoption (mock metadata, not SQL acceptance)', () => {
  it.each(incompatible)('refuses %s before recording/adopting a migration, including a forged matching ledger', async (_, change) => {
    const engine = fakeEngine(); change(engine.metadata); mocks.pool.mockImplementation(() => engine.pool());
    await expect(setupProductionSchema(env)).rejects.toThrow('structure');
    expect(engine.applied).toEqual([]);
    expect(engine.calls.some(sql => sql.startsWith('INSERT INTO rolebright_migrations'))).toBe(false);
    engine.applied.push(...migrations); engine.seed(createStagingState());
    const db = new ProductionDatabase(engine.pool(), productionTarget.database);
    expect(await db.readiness()).toEqual({ ready: false });
    await expect(db.read()).rejects.toThrow('structure');
  });
  it('recovers after compatible DDL completes but recording fails, without state seeding', async () => {
    const engine = fakeEngine(); mocks.pool.mockImplementation(() => engine.pool());
    engine.fail('INSERT INTO rolebright_migrations (version, checksum) VALUES (?, ?)', true);
    await expect(setupProductionSchema(env)).rejects.toThrow('unavailable');
    expect(engine.applied).toEqual([]);
    const validationReads = engine.calls.filter(sql => sql.includes('information_schema.COLUMNS')).length;
    await setupProductionSchema(env);
    expect(engine.applied).toEqual(migrations.map(({ version, checksum }) => ({ version, checksum })));
    expect(engine.calls.filter(sql => sql.includes('information_schema.COLUMNS')).length).toBeGreaterThan(validationReads);
    expect(engine.calls.filter(sql => sql === migrations[0].sql)).toHaveLength(2);
    expect(engine.calls.some(sql => sql.startsWith('INSERT INTO rolebright_state'))).toBe(false);
  });
  it('revalidates interrupted DDL and refuses a structure changed before a manual retry', async () => {
    const engine = fakeEngine(); mocks.pool.mockImplementation(() => engine.pool());
    engine.fail('INSERT INTO rolebright_migrations (version, checksum) VALUES (?, ?)', true);
    await expect(setupProductionSchema(env)).rejects.toThrow();
    engine.metadata.rolebright_state.keys = [];
    engine.calls.length = 0;
    await expect(setupProductionSchema(env)).rejects.toThrow('structure');
    expect(engine.applied).toEqual([]);
    expect(engine.calls.some(sql => sql.startsWith('INSERT INTO rolebright_migrations'))).toBe(false);
  });
  it('supports MariaDB metadata formatting and table-scoped constraint names, rejecting disabled checks', async () => {
    const engine = fakeEngine(); engine.version('5.5.5-10.11.6-MariaDB'); mocks.pool.mockImplementation(() => engine.pool());
    engine.metadata.rolebright_state.columns[0].column_type = 'tinyint(4)';
    engine.metadata.rolebright_state.columns[1].column_type = 'int(11)';
    engine.metadata.rolebright_state.columns[2].column_type = 'bigint(20) unsigned';
    engine.metadata.rolebright_migrations.columns[2].extra = '';
    engine.metadata.rolebright_migrations.columns[2].default_value = 'current_timestamp()';
    await setupProductionSchema(env);
    expect(engine.calls.some(sql => sql.includes('AND cc.TABLE_NAME = tc.TABLE_NAME'))).toBe(true);
    engine.seed(createStagingState());
    const db = new ProductionDatabase(engine.pool(), productionTarget.database);
    expect(await db.readiness()).toEqual({ ready: true });
    engine.checksEnabled(0);
    expect(await db.readiness()).toEqual({ ready: false });
  });
});
