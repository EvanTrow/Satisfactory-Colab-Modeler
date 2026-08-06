# Job 029: Accessibility pass, production deploy, backups, error tracking

**Phase:** 7 · Polish & deploy
**Status:** Not started
**Depends on:** 028 (i18n — last feature job; this is the final job in the roadmap)

## Context

Read [`PLAN.md`](../PLAN.md) section **3. Feature Scope → Later phases** ("accessibility pass, production deploy, backups, error tracking") and the confirmed decision from the intro ("a single container host with managed Postgres"). This is the final job in the roadmap — it takes the fully-featured app from Jobs 001-028 and makes it a real, monitored, backed-up production deployment.

## Scope

In scope:
- **Accessibility pass** across the whole app: keyboard navigation for the project list, auth flow, and as much of the canvas as is reasonably achievable (full canvas a11y for a node-graph editor has real limits — focus on what's practical: modal focus trapping in the Recipe Chooser, ARIA labels on icon-only buttons, sufficient color contrast in both themes from Job 014, screen-reader-reachable summary panel data). Document known limitations rather than claiming full WCAG compliance if the canvas interactions genuinely can't get there.
- **Production deploy**: `infra/Dockerfile` and deploy config for the "single container host with managed Postgres" decision (Fly.io/Railway/Render, per PLAN.md §10's confirmed-decisions list — pick one if not otherwise specified, Fly.io is a reasonable default) — build, deploy `apps/web` (as static assets or SSR, whichever the Vite setup produces), `apps/api`, and `apps/realtime` (co-deployed with api in one container, per PLAN.md §7's project structure note) against a managed Postgres instance.
- **Backups**: automated Postgres backups (daily snapshot at minimum) via whatever the chosen host provides natively, documented in `infra/`.
- **Error tracking**: integrate a basic error-tracking service (e.g. Sentry, or whatever's available/preferred) across `apps/web`, `apps/api`, `apps/realtime`, capturing unhandled exceptions and, ideally, the CRDT integrity-reducer firing (Job 022) as a signal worth tracking (since a repair firing often indicates a real bug elsewhere, even though the reducer's job is to make it non-fatal).
- Production environment variable/secrets handling (Discord OAuth secrets from Job 005, database URL, session signing keys, error-tracking DSN) — documented, not committed.

Out of scope:
- Any new product features — this is exclusively hardening/ops work on top of the complete MVP+Phase 6/7 feature set from Jobs 001-028.

## Deliverables

- `infra/Dockerfile` (multi-stage build for web/api/realtime as appropriate).
- Deploy configuration for the chosen host.
- Backup configuration/documentation.
- Error tracking integrated across all three apps.
- Accessibility audit notes (what was fixed, what's a known limitation) plus the actual fixes for anything addressed.
- Updated root README with production deploy instructions.

## Acceptance criteria

- Per PLAN.md §8's Phase 7 exit criterion: "Deployed, monitored, backed up."
- A production deployment is reachable, serves the app correctly end-to-end (login, create project, edit canvas, multiplayer), and errors surface in the tracking dashboard when deliberately triggered (test with an intentional thrown error).
- Backups are verifiably running (confirm at least one successful backup exists after setup).
- Keyboard-only navigation can complete the core flow: log in, open/create a project, add a node via the Recipe Chooser, and reach the summary panel — verify this manually and note results.
- No secrets committed to the repo — audit `.env`/config files before considering this done.

## Notes for the worker

- This is the last job in the roadmap ([`INDEX.md`](../jobs/INDEX.md)). When done, update this file's Status line and the row in the index, and consider whether any new follow-up jobs should be filed for known accessibility limitations or deferred features noted along the way.
