// Synthetic information_schema rows, not real engine acceptance.
export function schemaMetadata() {
  const column = (name: string, type: string, overrides: Record<string, unknown> = {}) => ({
    name, data_type: type.split(/[ (]/)[0], column_type: type, nullable: 'NO',
    char_length: null as number | null, charset: null as string | null, collation: null as string | null,
    extra: '', default_value: null as string | null, ...overrides,
  });
  return {
    rolebright_state: {
      tables: [{ engine: 'InnoDB', table_type: 'BASE TABLE' }],
      columns: [
        column('id', 'tinyint'), column('format_version', 'int'), column('revision', 'bigint unsigned'),
        column('document', 'longtext', { char_length: 4294967295, charset: 'utf8mb4', collation: 'utf8mb4_bin' }),
      ],
      keys: [{ name: 'PRIMARY', non_unique: 0, position: 1, column_name: 'id', sub_part: null as number | null }],
      constraints: [
        { kind: 'PRIMARY KEY', clause: null as string | null, enforced: 'YES' },
        { kind: 'CHECK', clause: '(`id` = 1)', enforced: 'YES' },
        { kind: 'CHECK', clause: 'json_valid(`document`)', enforced: 'YES' },
      ],
    },
    rolebright_migrations: {
      tables: [{ engine: 'InnoDB', table_type: 'BASE TABLE' }],
      columns: [
        column('version', 'int'), column('checksum', 'char(64)', { char_length: 64, charset: 'utf8mb4', collation: 'utf8mb4_bin' }),
        column('applied_at', 'timestamp', { default_value: 'CURRENT_TIMESTAMP', extra: 'DEFAULT_GENERATED' }),
      ],
      keys: [{ name: 'PRIMARY', non_unique: 0, position: 1, column_name: 'version', sub_part: null as number | null }],
      constraints: [{ kind: 'PRIMARY KEY', clause: null as string | null, enforced: 'YES' }],
    },
  };
}
