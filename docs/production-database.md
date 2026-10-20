# Production database adapter: pending activation

This change is an offline implementation, not a production cutover. Jack reported creating `u761630263_rb_prod` with `u761630263_rb_prodapp` for rolebright.app. No credential, grant, TLS endpoint, schema or live behavior has been verified by this patch. No connection or migration was performed. Staging remains separate.

## Selection and configuration

Application selection requires both `APP_ENV=production` and `PRODUCTION_STORAGE=mysql`. With no production selector the previous Drive/local selection remains. Unknown selector values or a selector under the wrong environment fail before clients run. Once selected, missing configuration, unavailable storage, absent state or corrupt data never fall back to Drive/local, even with `USE_LOCAL_STATE=true`.

Production exclusively consumes `PROD_DB_HOST`, optional `PROD_DB_PORT` (3306), `PROD_DB_NAME`, `PROD_DB_USER`, `PROD_DB_PASSWORD`, `PROD_DB_TLS=required`, and optional PEM `PROD_DB_CA`. The database/user must match the dedicated pair above. Do not reuse `DB_*`, `DATABASE_URL` or staging credentials. Names are guardrails; verify actual grants and server identity independently. Certificate-matching DNS is required; IP literals, plaintext, disabled chain verification and disabled hostname verification are unsupported. Configuration changes require process restart.

Do not copy `.env.example` wholesale to hosting: its `USE_LOCAL_STATE=true` is for local development. Keep it false/unset in production. Keep staging's `APP_ENV=staging` at both build and runtime. Never use that value on production to activate MySQL.

The shared engine preserves the existing singleton JSON state, transaction lock, revision CAS, unknown fields, pool/deadline limits and no-retry semantics. Snapshots are scoped to the adapter instance so a snapshot obtained from a different adapter cannot be saved. This is single-owner persistence, not multiuser authorization or new login readiness. Google authentication, document storage and token bootstrap remain separate; moving state to MySQL does not remove their dependencies.

## Read-only readiness

`ProductionDatabase.readiness()` is an operator-only module API, not a web route. It checks the actual database name, declared engine version, migration checksums, InnoDB tables and state document through SELECT only. Each invocation rechecks; results are sanitized to `{ ready: boolean }`. It does not call `getState`, migrate, seed or repair. Application initialization is SELECT-only too. Failed initialization stays failed for that instance; investigate before restarting.

`/api/health` remains liveness/configuration information, not DB readiness. Do not use a staging application GET as a read-only probe: the staging adapter still migrates and seeds on first use. A future live readiness call requires separate authority and verified connection settings. Merely importing these modules or building does not create a pool.

## Explicit privileged setup

`setupProductionSchema(env)` in `production-schema-setup.ts` is deliberately not imported by application storage, startup, health, or request handlers. It must be explicitly invoked by a reviewed operator integration. There is no shipping HTTP migration route, install hook, automatic command or credential creation.

It requires `APP_ENV=production`, `PROD_SCHEMA_SETUP=create-empty-schema`, the production endpoint/name/TLS settings, and separate `PROD_MIGRATION_USER`/`PROD_MIGRATION_PASSWORD`. The migration user must differ from the runtime user and cannot be a staging-named user. The operation does not require or persist application activation and ignores runtime credentials in favor of the separate migration identity. Flags are technical guards, not approval. Do not place migration credentials or setup flags in the application environment.

Setup verifies the selected database/engine before DDL, obtains a named lock, creates/checks additive versioned tables and records exact checksums. DDL implicitly commits; failure may leave partial schema. It never retries automatically, deletes data, or creates the state row. A successful schema setup still leaves readiness false until a separately reviewed initial-data/cutover operation supplies valid state. No initial-data import is included.

The runtime SQL requires SELECT/UPDATE on `rolebright_state` and SELECT on `rolebright_migrations`, plus visibility of those tables in information_schema. It requires no CREATE, INSERT, DELETE, DROP, global privileges or GRANT OPTION. Separately review temporary setup grants for CREATE and migration-metadata INSERT/SELECT. Check actual effective grants and cross-database denial before use; the code cannot establish grants from a username.

## Acceptance, activation and rollback

Provisioning, connection-only checks, schema setup, initial data and deployment/activation are separate gates. Preserve the existing data store and backups; do not silently adopt Drive/local data or seed synthetic records in production. Plan backup/restore, expected state, write freeze and reconciliation before a cutover. After MySQL writes begin, returning to Drive/local can expose stale data; rollback requires reconciliation, never automatic fallback or dropping tables.

Offline tests model SQL and concurrency, and synthetic loopback tests exercise the pinned driver's TLS behavior. They do not prove actual SQL compatibility, privileges or Hostinger operation. Later separately authorized disposable-engine tests must cover real migrations, grants/DDL denial, cross-database denial, locking, disconnects, restart persistence and supported engine/TLS behavior. Never use production as a synthetic write-test target.

No new dependency versions are introduced. See the accompanying implementation report for exact offline results. Current public registration, account ownership and authentication scope are unchanged.

## Offline validation, 2026-10-20

Base reconciled by authenticated read-only remote lookup: PR13 branch a908296503898f0c0ab349b0ee83e5bd9b139c06, staging 670ab6e38f76fe33d0f76f705e4af67660f1cb8b, main 1331661b9043a76dafc9585d3eaf94a80d756102. Implementation uses the reviewed PR13 base, without touching main or the paused identity worktree.

Windows Node24.14.0/npm11.14.1; locked official-registry npm ci with scripts disabled installed 588 packages. The initial sandboxed install failed with npm's “Exit handler never called”; the authorized registry retry succeeded. No dependency or lockfile changes.

Targeted typecheck and four test files/56 cases passed. First full `npm run qa` with APP_ENV=staging passed typecheck, lint, 13 files/125 tests and Next16.3.1 Turbopack build (21 generated entries). Two state-facade tests were then added. Final full `npm run qa` with APP_ENV=production and empty PRODUCTION_STORAGE passed typecheck, lint, 14 files/127 tests and build (21 generated entries). Both builds used only the existing local font mock and disabled telemetry. Both lint runs reported the same pre-existing DashboardClient.tsx:134 no-img-element warning, no errors.

Tests include all 83 baseline cases plus 44 new cases. TLS listeners bind disposable loopback ports and use the existing public synthetic test key/certificate; no MySQL handshake, credentials or provider call occurs. Mock SQL tests are not real engine tests. Final git diff checks passed. Auth/proxy/outbound guard sources and dependencies are unchanged.

NOT RUN: this patch's Node22 CI, real MySQL/MariaDB execution, Hostinger TLS/grants, live connection/readiness, migrations, initial state import, persistent configuration, restart/deployment acceptance, browser end-to-end tests, live authentication or provider integration. Previously reported PR13 Node22 CI applies to the base, not this new patch.
