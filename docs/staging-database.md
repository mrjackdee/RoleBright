# Dedicated staging database adapter

## Scope and engine contract

Base: 670ab6e38f76fe33d0f76f705e4af67660f1cb8b (2419a33d3c2c187eafafb246066aea4130be2a65 is an ancestor). The intervening PR #12 only changes the browser title to RoleBright trademark; it is preserved. Driver: mysql2 3.24.6, exact pin in package.json and lockfileVersion 3. Single-owner state storage only; no new login, multiuser ownership or public registration. Authentication, Cloudflare owner gate/JWT validation, analytics exclusion, noindex/private caching and outbound safeguards are unchanged.

Target: dedicated MySQL 8.0.16+ or MariaDB 10.6+ database, InnoDB tables, utf8mb4, JSON_VALID, prepared statements, session GET_LOCK, row locks and verified TLS. MariaDB's 5.5.5 compatibility version prefix is accepted. Actual Hostinger engine/version, TLS chain, grants, named-lock availability and transaction behavior still require verification. No real engine has been tested locally. No Docker/MySQL/MariaDB installation or service was found; none was installed.

Configuration (staging only): APP_ENV=staging, STAGING_STORAGE=mysql, DB_HOST (certificate-matching DNS hostname; IP literals rejected), optional DB_PORT (default 3306), DB_NAME (alphanumeric/underscore and must contain lowercase staging), DB_USER, DB_PASSWORD, DB_TLS=required, optional PEM DB_CA. DATABASE_URL is deliberately not consumed; use the individual DB_* values so there is one unambiguous configuration source. Proposed Hostinger target u761630263_rb_staging with user u761630263_rb_stageuser at 127.0.0.1:3306 is unverified, not provisioned by this patch. Root must resolve verified TLS availability and approve STAGING_STORAGE=mysql plus DB_TLS=required before enabling this adapter; the proposed six variables alone are insufficient. All credentials must belong exclusively to this staging database. Never reuse production credentials. Configuration names are a guardrail, not proof that a resource is isolated; provisioning review must verify the actual database and least-privilege grants. Both ssl.rejectUnauthorized and ssl.verifyIdentity are explicitly true. No plaintext or certificate-verification bypass is supported. IP literals are rejected because the pinned driver omits servername and its explicit post-handshake identity check for them. The proposed 127.0.0.1 endpoint is therefore blocked; obtain a verified certificate-matching DNS endpoint rather than weakening TLS. No fallback occurs for missing configuration, connection failure, corrupt documents or unsupported schema. USE_LOCAL_STATE cannot override staging selection. Production keeps its previous Google Drive/local selection unchanged and ignores these staging settings. Configuration changes require a process restart.

The new configuration must be approved and ready BEFORE deploying this code, otherwise staging storage intentionally becomes unavailable. This patch performs no provisioning or environment updates.

## Persistence and concurrency

A single row contains the entire JSON AppState, an envelope format_version=1 and a BIGINT revision. LONGTEXT avoids differing native-JSON representations in MySQL/MariaDB. JSON fields, including unrecognized nested fields, survive roundtrips without normalization. The existing AppState schemaVersion remains 1; unsupported envelope/schema versions fail closed rather than being overwritten. Documents are bounded at 8 MiB; server max_allowed_packet must accommodate them. Database state is never copied from local/Drive/production data.

getState returns an independent snapshot. updateState starts a transaction and locks the singleton row with SELECT ... FOR UPDATE before running its callback. All existing mutators were inspected: tracking; baseline selection; uploaded resume metadata; import; career profile replacement; issue logging; package metadata; search results; notification setting. Their callbacks mutate state only; provider work is outside the callbacks. Callback execution is exactly once. Do not add external effects or nested updateState calls inside a mutator. No deadlock, timeout or commit retry is performed automatically. A commit disconnection can mean success or failure: reload and inspect before a manual retry.

saveState uses atomic revision compare-and-swap, accepting only the original object returned by getState; stale or copied snapshots fail. No existing caller invokes saveState directly outside the storage module. This restriction prevents silent lost updates. It does not merge conflicts.

The pool has at most four connections, two idle connections, a 60-second idle timeout, five-second connect timeout, no waiting queue and multipleStatements disabled. Exhaustion fails immediately. Each adapter connection operation has a 20-second wall-clock deadline, including acquisition; a late-acquired connection is destroyed. Row-lock waits are five seconds. Failures roll back where possible and destroy the connection so unconfirmed rollback or named-lock release cannot contaminate the pool. Timed-out asynchronous callbacks cannot issue subsequent SQL through the expired operation. Driver errors are sanitized; no connection strings, secrets, SQL parameters or document contents are included in adapter errors. Callbacks must remain short and cannot be forcibly interrupted while executing synchronous CPU work.

## Migrations and seed

On first storage access in each process, a named lock derived from the database name serializes migration execution across processes. rolebright_migrations stores applied versions and SHA-256 checksums of exact DDL. Unknown versions/checksum changes fail closed. Migration 1 creates rolebright_state. Both tables explicitly use InnoDB, checked before seeding.

DDL has implicit commits, so the runner deliberately does NOT pretend that CREATE TABLE plus its migration record is transactional. DDL is CREATE TABLE IF NOT EXISTS and can be replayed after a crash before the version record. The lock survives DDL commits. A failed initialization stays failed in that process; inspect and restart after resolving it. Do not edit an applied migration: add a new version with an explicitly reviewed resumable plan. Never introduce destructive automatic resets.

The seed uses INSERT ... ON DUPLICATE KEY UPDATE id=id. It creates the fictional state only if the singleton row is absent and never replaces existing edits. Links remain /guide; tracking is local records, not employer submissions. First initialization is not a migration of the prior local file; retaining earlier synthetic file edits would need a separate reviewed import, not an implicit fallback.

## Rollback — review before deployment

1. Before first deployment, verify the dedicated staging resource, TLS, engine, grants and backup/restore procedure. Retain a verified staging-only backup before any future migration. Hostinger integration testing and deployment need explicit coordination.
2. Prefer a forward fix or rollback to a reviewed revision compatible with envelope version 1 and the existing schema. Keep APP_ENV=staging and every outbound/Cloudflare safeguard.
3. Reverting application code does NOT revert migrations. Do not drop tables, delete migration records, reseed, or copy state into production during rollback. Leave database/test edits intact for recovery.
4. The exact pre-adapter base 2419a33 includes the safeguards but reads local staging fixtures, not the database: using it would temporarily hide DB edits. Only do this knowingly with the staging database retained and a recovery plan. Never roll back to a pre-safeguard version or point production at staging DB.
5. No rollback action is currently needed: this work is local and unpushed. Parent coordinates independent review before PR/push and any deployment. Main and release PR #9 remain untouched.

## Validation gates

Mocks model SQL protocol, locking, rollback and reconnect persistence; they do not execute SQL. The baseline 53 tests are retained (the former local-staging-storage assertion now requires fail-closed DB configuration). New tests cover migration/seed repeatability, edits surviving pool recreation, full/unknown JSON state, stale saves, concurrent adapters, failed callbacks/writes, uncertain commit, timeouts, migration checksum/version mismatch, DDL interruption, version parsing, pooling/TLS configuration, missing/unavailable DB with no fallback and unchanged production selection. Existing tests still supply accidental Google/email/AI/search credentials and verify that those clients are never called.

NOT RUN: real MySQL or MariaDB SQL/migrations/locking/timeout/TLS acceptance; Hostinger provisioning/integration; actual restart/deployment persistence; browser end-to-end tracking; live authentication/provider calls. A provisioning handoff must confirm the exact approved target and secure settings without exposing secret values. Then test migration twice, preserve a synthetic edit across restart/redeployment, concurrent updates from separate actual connections/processes, rollback and disconnect behavior, and all staging guard checks before acceptance. Do not equate mock tests with database acceptance.

Build-only font mocking uses NEXT_FONT_GOOGLE_MOCKED_RESPONSES pointing to tests/fixtures/font-responses.cjs and NEXT_TELEMETRY_DISABLED=1, set on the validation process only. It prevents Google font calls and is not production font acceptance. Do not configure the font mock on hosting.

References: MySQL named locks survive transaction commit/rollback (https://dev.mysql.com/doc/refman/8.0/en/locking-functions.html); DDL implicit commits (https://dev.mysql.com/doc/refman/8.0/en/implicit-commit.html); MariaDB named-lock semantics (https://mariadb.com/docs/server/reference/sql-functions/secondary-functions/miscellaneous-functions/get_lock); mysql2 pool/prepared statement documentation (https://sidorares.github.io/node-mysql2/docs).

## Local validation result (2026-10-15 UTC)

On source base 670ab6e38f76fe33d0f76f705e4af67660f1cb8b, Windows Node v24.14.0/npm 11.14.1, Next 16.3.1 and Vitest 3.2.7: clean npm ci from registry.npmjs.org with --ignore-scripts succeeded (588 packages); final npm run qa exited 0. Typecheck passed; lint passed with the pre-existing DashboardClient.tsx:134 no-img-element warning; 9 test files/75 tests passed (53 baseline plus 22 new); standard Turbopack build passed and generated 21 static entries. APP_ENV=staging and the explicit local-font mock were process-only validation settings; no database configuration or credentials were supplied. Node 22/Hostinger acceptance remains NOT RUN.

Build diagnosis: the earlier sandboxed Turbopack run could not start its font evaluator. Outside the sandbox it exposed an invalid Proxy response mock (Turbopack serializes the map). An explicit URL map with local font sources fixed the standard build. An intermediate fake .invalid font URL caused failed DNS resource requests, not provider authentication or data access; the final mock has no remote font source. A diagnostic --webpack build separately failed on the pre-existing node:crypto import from utils.ts into DashboardClient; that unrelated path was not modified or claimed to pass. Production/live font delivery was not tested.

## Sadie review follow-up: TLS identity

Prior commit 4417682706c1094b400a089745d98d20a7079d75 is retained. Sadie's P1 is confirmed in pinned mysql2 3.24.6: lib/connection_config.js defaults rejectUnauthorized but not verifyIdentity; lib/base/connection.js:430-454 selects a no-op identity callback unless verifyIdentity is true. The adapter now explicitly sets both true. IP-literal DB_HOST values are rejected before driver construction, since mysql2 suppresses servername and its explicit post-handshake check on that path. This restriction does not change any hosting value; the proposed endpoint remains an unresolved gate.

Eight new tests exercise the installed driver's actual PoolConfig and startTLS implementation, not only our option shape. Six no-network cases check effective configuration, Node's real checkServerIdentity selection, mismatched certificate rejection with simulated chain trust, IPv4/IPv6 rejection and ignored environment attempts to disable verification. Two real TLS-only loopback cases use the included synthetic certificate as a trusted anchor: matching db.example.invalid is authorized, while wrong.example.invalid yields ERR_TLS_CERT_ALTNAME_INVALID. The listener binds only 127.0.0.1 on an ephemeral port, cleans up all sockets, and never sends a MySQL handshake or authentication packet. Fixtures synthetic-tls-key.pem and synthetic-tls-cert.pem are public, disposable test material for .invalid only; NEVER use them as deployment credentials/certificates. No Hostinger credentials were read or used.

The two socket tests initially encountered sandbox EACCES and then passed when authorized local-loopback execution was permitted. This is actual TLS hostname/chain testing against a synthetic endpoint, NOT Hostinger TLS, database or grant acceptance. All existing live holds remain.

### Independent build reproduction without dependency junctions

Use a new disposable directory, export the exact review commit, and install its locked dependencies physically inside that directory. Do not junction/symlink node_modules outside the source root: Turbopack rejects that arrangement. Do not modify the existing review copy. Example PowerShell steps in a fresh process (replace REV with the reviewed follow-up commit):

```powershell
git -C C:\Users\drjac\Documents\Codex\2026-10-14\task-6\RoleBright-db archive --format=zip --output=C:\Users\drjac\AppData\Local\Temp\rolebright-review.zip REV
Expand-Archive -LiteralPath C:\Users\drjac\AppData\Local\Temp\rolebright-review.zip -DestinationPath C:\Users\drjac\AppData\Local\Temp\rolebright-review-fresh
Set-Location C:\Users\drjac\AppData\Local\Temp\rolebright-review-fresh
npm ci --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund
$env:APP_ENV='staging'
$env:STAGING_STORAGE=''
$env:NEXT_TELEMETRY_DISABLED='1'
$env:NEXT_FONT_GOOGLE_MOCKED_RESPONSES=(Resolve-Path tests/fixtures/font-responses.cjs).Path
npm run qa
```

Use fresh unused archive/directory paths on subsequent attempts. No .env files, database credentials, database service, or external font requests are needed. Local loopback sockets and child-process execution must be allowed; if blocked, report that limitation rather than claiming those tests passed. Hosting Node 22 validation remains a separate gate; the builder uses Node 24.14.0. The font fixture supplies local font sources and does not validate production font delivery.

Follow-up full QA: 2026-10-15 UTC, Node 24.14.0/npm 11.14.1, npm run qa exited 0; typecheck passed, lint passed with the same one pre-existing image warning, 10 test files/83 tests passed, and standard Next 16.3.1 Turbopack build passed (21 generated entries). Evidence: sibling staging-db-tls-qa.log. No dependency versions changed from 4417682.
