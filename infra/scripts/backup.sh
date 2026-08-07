#!/usr/bin/env bash
# Job 029: the pg_dump FALLBACK backup script — see infra/BACKUPS.md's own
# "Fallback" section for when this is actually the right tool (only when
# the chosen managed-Postgres host has no native automated backup feature
# at all; every mainstream option this app's README recommends does).
#
# Deliberately does NOT upload anywhere itself — this sandbox has no real
# object-storage bucket to test an upload against, and hardcoding one
# provider's CLI (aws/rclone/etc.) here would be dead, untested code. The
# ONE thing this script does that's actually verifiable without a real
# cloud account is produce a correct, restorable dump file locally; the
# upload step is a single documented line for a human to fill in for
# wherever they actually want backups stored.
#
# Usage:
#   DATABASE_URL=postgresql://user:pass@host:5432/db ./infra/scripts/backup.sh [output-dir]
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "backup.sh: DATABASE_URL is not set" >&2
  exit 1
fi

OUTPUT_DIR="${1:-./backups}"
mkdir -p "$OUTPUT_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT_FILE="$OUTPUT_DIR/scm-backup-$TIMESTAMP.sql.gz"

echo "backup.sh: dumping $DATABASE_URL -> $OUTPUT_FILE"
# --no-owner/--no-privileges: this app's own migrations (db/migrations/)
# already create every role/grant a restore needs — baking in the SOURCE
# database's specific role names would make the dump harder to restore
# into a fresh instance with different role setup (exactly the "restore
# into a NEW instance" step infra/BACKUPS.md's runbook calls for).
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > "$OUTPUT_FILE"

echo "backup.sh: done ($(du -h "$OUTPUT_FILE" | cut -f1))"
echo "backup.sh: upload $OUTPUT_FILE to your chosen off-site storage now — this script does not do that step itself (see this file's own header comment)."
