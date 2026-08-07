# Backups

## Scope boundary

**Nothing in this file has actually provisioned a real backup.** This
sandbox has no real cloud hosting account (see the root `README.md`'s
"Production deploy" section and `jobs/029-a11y-deploy.md`'s Handoff notes
for the full statement of that boundary). This document is what a human
needs to actually wire up against their own real managed-Postgres
account's backup feature once one exists.

## What needs to be backed up

**The whole Postgres database — nothing else.** This app has no separate
object/blob storage: game data (`resources/game_data.json`) is static,
committed, read-only reference data that ships inside every deploy, not
per-user data. Every piece of real user data lives in Postgres:

| Table(s) | What's in it |
|---|---|
| `users`, `sessions` | Discord identity, active login sessions |
| `projects`, `project_members`, `project_invites` | Project metadata, sharing/roles |
| `project_doc_state`, `project_doc_updates` | **The canonical source of truth for every project's canvas content** — the compacted Yjs snapshot + incremental update log (PLAN.md §4). This is the one table group where data loss is catastrophic and irreversible: it's the only copy of every factory anyone has ever built. |
| `project_versions` | Named/auto version-history snapshots (Job 016) |
| `proj_nodes`, `proj_edges` | A read-only server-side *projection* of the CRDT above (Job 025) — technically re-derivable by replaying `project_doc_state`/`project_doc_updates` through `packages/doc-storage`'s projection code, so losing just these two tables (with everything else intact) is recoverable without a backup at all. Still worth backing up as part of a routine full-database dump — cheaper than writing and testing a recovery script for a scenario a normal backup already covers for free.

A single `pg_dump`/PITR-based backup of the whole database covers all of
it — there is no reason to back up anything at a finer grain than "the
whole database."

## Recommended approach: use the managed host's native backups

PLAN.md's confirmed decision is "a single container host with **managed**
Postgres" — the entire point of that choice is that backup infrastructure
(WAL archiving, point-in-time recovery, retention policies, off-site
replication) is the managed provider's job, not this app's. Do not build a
custom `pg_dump`-to-S3 cron job unless the chosen provider genuinely has no
backup feature at all (see the fallback further down).

### If using Fly.io (this job's chosen deploy target — see `infra/fly.toml`)

Fly offers two Postgres products; pick based on what actually exists when
you deploy:

- **Fly Managed Postgres (MPG)** — Fly's fully-managed offering. Automated
  backups and point-in-time recovery are built in and enabled by default;
  no extra setup step. This is the one that actually matches PLAN.md's
  "managed Postgres" wording literally — prefer it if available in your
  target region.
- **Legacy `fly postgres create` (self-run, HA-replica-based)** — this is
  a regular Fly app running Postgres yourself, NOT automatically backed
  up. If this is what you end up with (e.g. MPG isn't available in your
  region yet), you must either migrate to MPG or set up your own backup
  job — see the fallback section below.

Either way, after provisioning:

```sh
fly postgres attach <postgres-app-name>   # wires DATABASE_URL into the app's secrets automatically
```

Verify backups exist (exact command depends on which product — check
`fly postgres backups list` / the Fly dashboard's Postgres backups tab for
your specific app once created; this could not be run in this sandbox
since no Fly account exists here).

### If using a different managed provider (Neon, Supabase, Railway Postgres, AWS RDS, etc.)

Every one of these has native automated backups as a first-class,
documented feature — Neon and Supabase both default to continuous/PITR
backup on their paid tiers (verify your plan actually includes it, some
free tiers don't); RDS has automated backups + snapshots built into the
console. Enable it, set retention to at least 7 days (30+ if the budget
allows), and confirm at least one backup completed before considering this
job's "backups are verifiably running" acceptance criterion met in a real
deployment.

## Suggested cadence

**Daily, at minimum** (per this job's own acceptance criteria) — a WAL-
based/PITR system (Fly MPG, Neon, RDS) gives you far better than daily
granularity for free once enabled; a plain nightly `pg_dump` snapshot (the
fallback below) should run at minimum once every 24 hours.

## Fallback: a plain `pg_dump` cron job

Only needed if the chosen host genuinely has no native backup feature.
`infra/scripts/backup.sh` (this repo) is a minimal, working example — a
human adapts the upload step to wherever they want backups stored (S3,
Backblaze, Fly's own Tigris object storage, etc.) since this sandbox has
no such bucket to test against:

```sh
DATABASE_URL=... ./infra/scripts/backup.sh
```

Run it on a schedule via whatever the host provides (a Fly Machine on a
cron-like schedule, GitHub Actions on a schedule, etc.) — there is no
in-app scheduler for this, deliberately: backup infrastructure living
inside the same app it's backing up is a single point of failure a real
production setup shouldn't have.

## Restore runbook

1. **Identify the backup** to restore from (a PITR timestamp, or a
   specific `pg_dump` file from `infra/scripts/backup.sh`'s fallback).
2. **Restore into a NEW Postgres instance** first — never restore
   directly over the live production database. Managed-provider PITR
   (Fly MPG/Neon/RDS) does this by creating a new instance from the
   snapshot/point in time automatically; for a plain `pg_dump` file:
   ```sh
   createdb scm_restore_test
   psql scm_restore_test < backup-2026-08-07.sql
   ```
3. **Verify the restore** before cutting over: point a scratch copy of
   `apps/api` at the restored instance (`DATABASE_URL` override) and
   confirm `GET /api/projects` for a known account returns the expected
   projects, and that a project's canvas actually opens with its expected
   content (not just that the tables have rows — Yjs state can be
   present-but-corrupt in ways a row count won't catch; opening it and
   letting `packages/ydoc`'s integrity reducer run over it, per Job 022, is
   itself part of what "verify the restore" should mean here).
4. **Cut over**: update `DATABASE_URL` (Fly secret / host equivalent) to
   point at the restored instance, redeploy, confirm `/health` and a real
   login+project-open still work end to end.
5. **Only after cutover is confirmed working**, decommission the old
   (corrupted/lost) instance — don't delete it as part of the restore
   itself.
