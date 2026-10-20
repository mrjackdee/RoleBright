import { createHash } from 'node:crypto';
// DDL implicitly commits in MySQL/MariaDB. Run under a connection-scoped named lock,
// not a transaction. Every statement must tolerate replay after a crash before recording.
export const migrationTable = `CREATE TABLE IF NOT EXISTS rolebright_migrations (
  version INT PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB`;
export const migrations = [{ version: 1, sql: `CREATE TABLE IF NOT EXISTS rolebright_state (
  id TINYINT PRIMARY KEY, format_version INT NOT NULL, revision BIGINT UNSIGNED NOT NULL,
  document LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  CHECK (id = 1), CHECK (JSON_VALID(document))
) ENGINE=InnoDB` }].map(m => ({ ...m, checksum: createHash('sha256').update(m.sql).digest('hex') }));
