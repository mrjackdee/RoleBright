# RoleBright development and releases

Production: https://rolebright.app follows `main`.
Staging: https://test.rolebright.app follows `staging`.

## Feature work
Create a short-lived `feature/<name>` or `fix/<name>` from staging. Open a pull request into staging. Run `npm ci` and `npm run qa`; all quality checks must pass. Merge with a merge commit. Test the staging deployment before preparing a release. Delete only merged short-lived branches; keep main and staging.

## Releases
Open a pull request from staging into main describing the tested changes. The owner reviews and merges it; a second person's approval is not required. Always use **Create a merge commit** for staging -> main: do not squash or rebase this long-lived branch. Hostinger deploys main automatically. After verifying production, tag the released main commit (for example v1.0.1), and merge main back into staging through a pull request. Do not force-push either branch.

## Hotfix and rollback
Branch urgent fixes from main, validate through a pull request, then merge into main and sync main back into staging through a second pull request. To roll back code, create a fix branch from main and revert the release merge with `git revert -m 1 <release-merge-sha>`, run checks, and merge the rollback pull request. This does not undo external data changes. Preserve the rollback in staging too. To reintroduce a reverted release, revert the rollback on a feature branch and test again.

## Staging isolation
Hostinger staging uses Node 22, Next.js, npm, build script `build`, output `.next`, and APP_ENV=staging. USE_LOCAL_STATE=true uses a separate local data/state.json initialized with empty synthetic state. Treat this data as disposable; deployment may replace it. Never copy production Google credentials, tokens, folders, user documents, or other secrets to staging.

Google Drive and email delivery are explicitly disabled in staging. Scheduled jobs and Google OAuth routes are blocked. No paid API keys or cron secret are provisioned. Existing application session protection remains enabled; no public authentication bypass is added. Staging responses carry noindex headers.

### Remaining Google integration work
Full signed-in staging testing requires a separate Google OAuth client and isolated Google Drive folders/service account, followed by an explicit integration-mode change and tests. Register https://test.rolebright.app/api/auth/google/callback on that separate client. The current isolated mode deliberately blocks Google sign-in and Drive. Provision secrets through hosting settings, never source control. Keep email and scheduled searches disabled until a safe test strategy is approved.

## Feature flags
Keep unfinished work out of staging releases, or add explicit feature flags defaulting off. Every change on staging is included when staging is merged into main.
