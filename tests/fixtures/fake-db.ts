import type { Pool } from 'mysql2/promise';
import { vi } from 'vitest';
import { schemaMetadata } from './schema-metadata';
export function fakeEngine() {
  const metadata = schemaMetadata();
  let checksEnabled = 1;
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
          if (sql.startsWith('SELECT DATABASE()')) return [[{ database_name: 'u761630263_rb_prod', version }]];
          if (sql.startsWith('SELECT VERSION')) return [[{ version }]];
          if (sql.includes('FROM information_schema.') && values.length === 2) {
            const table = metadata[values[1] as keyof typeof metadata];
            if (sql.includes('FROM information_schema.TABLES ')) return [structuredClone(table.tables)];
            if (sql.includes('FROM information_schema.COLUMNS ')) return [structuredClone(table.columns)];
            if (sql.includes('FROM information_schema.STATISTICS')) return [structuredClone(table.keys)];
            if (sql.includes('FROM information_schema.TABLE_CONSTRAINTS')) return [structuredClone(table.constraints)];
          }
          if (sql.startsWith('SELECT @@SESSION.check_constraint_checks')) return [[{ checks_enabled: checksEnabled }]];
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
  return { pool, calls, applied, connections, metadata, checksEnabled: (value: number) => { checksEnabled = value; }, seed: (value: unknown) => { document = JSON.stringify(value); }, corrupt: () => { document = 'not-json'; }, fail: (sql: string, once = false) => { fail = sql; failOnce = once; }, hang: (sql: string) => { hang = sql; }, version: (v: string) => { version = v; } };
}
