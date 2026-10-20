import 'server-only';
import { DatabaseError } from './database-error';
import type { Sql } from './mysql-state';

type Table = 'rolebright_state' | 'rolebright_migrations';
type Column = {
  name: string; data_type: string; column_type: string; nullable: string;
  char_length: number | string | null; charset: string | null; collation: string | null;
  extra: string; default_value: string | null;
};
const expected: Record<Table, Record<string, RegExp>> = {
  rolebright_state: {
    id: /^tinyint(?:\(\d+\))?$/, format_version: /^int(?:\(\d+\))?$/,
    revision: /^bigint(?:\(\d+\))? unsigned$/, document: /^longtext$/,
  },
  rolebright_migrations: {
    version: /^int(?:\(\d+\))?$/, checksum: /^char\(64\)$/, applied_at: /^timestamp$/,
  },
};

// Deliberately strict contract for v1. Metadata reads cannot repair/adopt a
// merely similar table. Unknown shapes require a separately reviewed migration.
export async function checkProductionTable(sql: Sql, database: string, table: Table, maria: boolean): Promise<void> {
  const invalid = () => { throw new DatabaseError('Incompatible production table structure.'); };
  const tables = await sql('SELECT ENGINE AS engine, TABLE_TYPE AS table_type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [database, table]) as { engine: string; table_type: string }[];
  if (tables.length !== 1 || tables[0].engine !== 'InnoDB' || tables[0].table_type !== 'BASE TABLE') invalid();
  const columns = await sql(`SELECT COLUMN_NAME AS name, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type,
    IS_NULLABLE AS nullable, CHARACTER_MAXIMUM_LENGTH AS char_length, CHARACTER_SET_NAME AS charset,
    COLLATION_NAME AS collation, EXTRA AS extra, COLUMN_DEFAULT AS default_value
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [database, table]) as Column[];
  const spec = expected[table];
  if (columns.length !== Object.keys(spec).length || new Set(columns.map(c => c.name)).size !== columns.length) invalid();
  for (const c of columns) {
    const type = c.column_type.toLowerCase();
    if (!spec[c.name]?.test(type) || c.data_type.toLowerCase() !== type.split(/[ (]/)[0] || c.nullable !== 'NO') invalid();
    if (c.name === 'applied_at') {
      if (!/^(?:DEFAULT_GENERATED)?$/i.test(c.extra) || !/^current_timestamp(?:\(\))?$/i.test(c.default_value ?? '')) invalid();
    } else if (c.extra !== '' || c.default_value !== null) invalid();
    if (c.name === 'document' && (!(Number(c.char_length) >= 8 * 1024 * 1024) || c.charset !== 'utf8mb4' || c.collation !== 'utf8mb4_bin')) invalid();
    if (c.name === 'checksum' && String(c.char_length) !== '64') invalid();
  }
  const keys = await sql(`SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS position,
    COLUMN_NAME AS column_name, SUB_PART AS sub_part FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [database, table]) as {
      name: string; non_unique: number; position: number; column_name: string; sub_part: number | null;
    }[];
  if (keys.length !== 1 || keys[0].name !== 'PRIMARY' || Number(keys[0].non_unique) !== 0 ||
      Number(keys[0].position) !== 1 || keys[0].column_name !== (table === 'rolebright_state' ? 'id' : 'version') || keys[0].sub_part !== null) invalid();
  const constraints = await sql(`SELECT tc.CONSTRAINT_TYPE AS kind, cc.CHECK_CLAUSE AS clause,
    ${maria ? "'YES'" : 'tc.ENFORCED'} AS enforced FROM information_schema.TABLE_CONSTRAINTS tc
    LEFT JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
      AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME${maria ? ' AND cc.TABLE_NAME = tc.TABLE_NAME' : ''}
    WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?`, [database, table]) as { kind: string; clause: string | null; enforced: string }[];
  if (constraints.filter(c => c.kind === 'PRIMARY KEY').length !== 1 ||
      constraints.some(c => c.kind !== 'PRIMARY KEY' && c.kind !== 'CHECK')) invalid();
  const checks = constraints.filter(c => c.kind === 'CHECK');
  const clauses = checks.map(c => (c.clause ?? '').toLowerCase().replace(/[\s`()]/g, '')).sort();
  const required = table === 'rolebright_state' ? ['id=1', 'json_validdocument'] : [];
  if (checks.some(c => c.enforced !== 'YES') || JSON.stringify(clauses) !== JSON.stringify(required)) invalid();
  if (maria) {
    const flags = await sql('SELECT @@SESSION.check_constraint_checks AS checks_enabled') as { checks_enabled: number }[];
    if (Number(flags[0]?.checks_enabled) !== 1) invalid();
  }
}
